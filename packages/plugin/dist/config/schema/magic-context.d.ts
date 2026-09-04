import { z } from "zod";
import type { AGENTIC_DREAM_TASKS } from "../../features/magic-context/dreamer/task-registry";
export declare const DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE = 65;
export declare const EXECUTE_THRESHOLD_CAP_MESSAGE = "execute_threshold is capped at 90% for cache safety: output capacity is reserved from the usable context window, and the remaining 10% absorbs mid-turn growth before the absolute 95% emergency wall. Use a value between 20 and 90.";
export declare const DEFAULT_HISTORIAN_TIMEOUT_MS = 300000;
export declare const DEFAULT_HISTORY_BUDGET_PERCENTAGE = 0.15;
export declare const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
/** The previous local default. Setup wizards used to write it as an explicit
 *  pin, so configs carrying this exact value are almost always echoing the
 *  then-default rather than expressing a preference. Doctor surfaces those pins
 *  with the remedy; nothing rewrites a user's config automatically, because the
 *  file carries no provenance and a deliberate pin must keep working. */
export declare const RETIRED_DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export type DreamingTask = (typeof AGENTIC_DREAM_TASKS)[number];
/** Valid thinking levels for Pi subagents. Maps to Pi's --thinking CLI flag.
 *  Off: disable reasoning. Minimal/low/medium/high/xhigh/max: increasing reasoning depth.
 *  `max` was added in Pi 0.83.0.
 *  Pi-only — OpenCode uses `variant` in agent config instead. */
export declare const PiThinkingLevelSchema: z.ZodOptional<z.ZodEnum<{
    off: "off";
    minimal: "minimal";
    low: "low";
    medium: "medium";
    high: "high";
    xhigh: "xhigh";
    max: "max";
}>>;
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;
/** Pi-only child-process controls. This block is intentionally optional so an
 * absent allowlist preserves Pi's normal extension discovery behavior. */
export declare const PiConfigSchema: z.ZodOptional<z.ZodObject<{
    subagent_extensions: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>>;
export type PiConfig = NonNullable<z.infer<typeof PiConfigSchema>>;
/**
 * Route the built-in prompt surface without changing guidance or tool registration.
 * Project config can choose preset routing; only user config can provide override text.
 */
export declare const PromptSurfacePresetSchema: z.ZodEnum<{
    full: "full";
    light: "light";
}>;
export type { PromptSurfacePreset } from "../../shared/prompt-surface";
export declare const PromptSurfaceConfigSchema: z.ZodObject<{
    default: z.ZodDefault<z.ZodEnum<{
        full: "full";
        light: "light";
    }>>;
    models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodEnum<{
        full: "full";
        light: "light";
    }>>>;
    guidance_override_path: z.ZodOptional<z.ZodString>;
    tool_descriptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export type PromptSurfaceConfig = z.infer<typeof PromptSurfaceConfigSchema>;
export declare const DreamTaskConfigSchema: z.ZodObject<{
    schedule: z.ZodDefault<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
    thinking_level: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
    timeout_minutes: z.ZodDefault<z.ZodNumber>;
    promotion_threshold: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
export type DreamTaskConfig = z.infer<typeof DreamTaskConfigSchema>;
/** The `tasks` record: one entry per canonical task, each defaulting to its
 *  v1-behavior-preserving schedule. Written explicitly (not via fromEntries) so
 *  the inferred type stays a precise per-key object. */
export declare const DreamTasksSchema: z.ZodObject<{
    "map-memories": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    verify: z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "verify-broad": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    curate: z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "compress-cues": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "classify-memories": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    retrospective: z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "maintain-docs": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "evaluate-smart-notes": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    "review-user-memories": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
        promotion_threshold: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    "promote-primers": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
        promotion_threshold: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    "refresh-primers": z.ZodDefault<z.ZodObject<{
        schedule: z.ZodDefault<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        timeout_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** Combined dreamer agent + per-task scheduling configuration (Dreamer v2). */
export declare const DreamerConfigSchema: z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    temperature: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    prompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    disable: z.ZodOptional<z.ZodBoolean>;
    description: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        subagent: "subagent";
        all: "all";
    }>>;
    color: z.ZodOptional<z.ZodString>;
    maxSteps: z.ZodOptional<z.ZodNumber>;
    permission: z.ZodOptional<z.ZodObject<{
        edit: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>]>>;
        webfetch: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        doom_loop: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        external_directory: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
    }, z.core.$strip>>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    variant: z.ZodOptional<z.ZodString>;
    fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
    tasks: z.ZodDefault<z.ZodObject<{
        "map-memories": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        verify: z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "verify-broad": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        curate: z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "compress-cues": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "classify-memories": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        retrospective: z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "maintain-docs": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "evaluate-smart-notes": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        "review-user-memories": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
            promotion_threshold: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        "promote-primers": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
            promotion_threshold: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        "refresh-primers": z.ZodDefault<z.ZodObject<{
            schedule: z.ZodDefault<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
            thinking_level: z.ZodOptional<z.ZodEnum<{
                off: "off";
                minimal: "minimal";
                low: "low";
                medium: "medium";
                high: "high";
                xhigh: "xhigh";
                max: "max";
            }>>;
            timeout_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    inject_docs: z.ZodDefault<z.ZodBoolean>;
    thinking_level: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
}, z.core.$strip>;
export type DreamerConfig = z.infer<typeof DreamerConfigSchema>;
export declare const SidekickConfigSchema: z.ZodOptional<z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    temperature: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    prompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    disable: z.ZodOptional<z.ZodBoolean>;
    description: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        subagent: "subagent";
        all: "all";
    }>>;
    color: z.ZodOptional<z.ZodString>;
    maxSteps: z.ZodOptional<z.ZodNumber>;
    permission: z.ZodOptional<z.ZodObject<{
        edit: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>]>>;
        webfetch: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        doom_loop: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        external_directory: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
    }, z.core.$strip>>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    variant: z.ZodOptional<z.ZodString>;
    fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
    timeout_ms: z.ZodDefault<z.ZodNumber>;
    system_prompt: z.ZodOptional<z.ZodString>;
    thinking_level: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
}, z.core.$strip>>;
export type SidekickConfig = NonNullable<z.infer<typeof SidekickConfigSchema>>;
/** Historian agent configuration — includes all agent overrides plus two_pass mode.
 *  Two-pass mode runs a second editor pass after the initial historian pass to clean
 *  up low-signal U: lines and cross-compartment duplicates. Recommended for models
 *  without extended thinking; not needed for Claude Sonnet/Opus when reasoning is
 *  enabled via OpenCode variant config. */
export declare const HistorianConfigSchema: z.ZodOptional<z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    temperature: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    prompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    disable: z.ZodOptional<z.ZodBoolean>;
    description: z.ZodOptional<z.ZodString>;
    mode: z.ZodOptional<z.ZodEnum<{
        primary: "primary";
        subagent: "subagent";
        all: "all";
    }>>;
    color: z.ZodOptional<z.ZodString>;
    maxSteps: z.ZodOptional<z.ZodNumber>;
    permission: z.ZodOptional<z.ZodObject<{
        edit: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>]>>;
        webfetch: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        doom_loop: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
        external_directory: z.ZodOptional<z.ZodEnum<{
            deny: "deny";
            allow: "allow";
            ask: "ask";
        }>>;
    }, z.core.$strip>>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    variant: z.ZodOptional<z.ZodString>;
    fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
    two_pass: z.ZodDefault<z.ZodBoolean>;
    thinking_level: z.ZodOptional<z.ZodEnum<{
        off: "off";
        minimal: "minimal";
        low: "low";
        medium: "medium";
        high: "high";
        xhigh: "xhigh";
        max: "max";
    }>>;
    disallowed_tools: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        "*": "*";
        read: "read";
        aft_outline: "aft_outline";
        aft_zoom: "aft_zoom";
        aft_search: "aft_search";
    }>>>;
}, z.core.$strip>>;
export type HistorianConfig = NonNullable<z.infer<typeof HistorianConfigSchema>>;
declare const EmbeddingFallbackProviderSchema: z.ZodEnum<{
    off: "off";
    local: "local";
    "openai-compatible": "openai-compatible";
}>;
export declare const EmbeddingConfigSchema: z.ZodPipe<z.ZodObject<{
    provider: z.ZodDefault<z.ZodEnum<{
        off: "off";
        local: "local";
        "openai-compatible": "openai-compatible";
        synapse: "synapse";
    }>>;
    fallback_provider: z.ZodOptional<z.ZodEnum<{
        off: "off";
        local: "local";
        "openai-compatible": "openai-compatible";
    }>>;
    model: z.ZodOptional<z.ZodString>;
    endpoint: z.ZodOptional<z.ZodString>;
    api_key: z.ZodOptional<z.ZodString>;
    input_type: z.ZodOptional<z.ZodString>;
    query_input_type: z.ZodOptional<z.ZodString>;
    truncate: z.ZodOptional<z.ZodString>;
    max_input_tokens: z.ZodOptional<z.ZodNumber>;
    local_dtype: z.ZodOptional<z.ZodEnum<{
        auto: "auto";
        fp32: "fp32";
        fp16: "fp16";
        q8: "q8";
        int8: "int8";
        uint8: "uint8";
        q4: "q4";
        bnb4: "bnb4";
        q4f16: "q4f16";
        q2: "q2";
        q2f16: "q2f16";
        q1: "q1";
        q1f16: "q1f16";
    }>>;
}, z.core.$strip>, z.ZodTransform<{
    max_input_tokens?: number | undefined;
    truncate?: string | undefined;
    query_input_type?: string | undefined;
    input_type?: string | undefined;
    api_key?: string | undefined;
    endpoint?: string | undefined;
    model?: string | undefined;
    fallback_provider?: "off" | "local" | "openai-compatible" | undefined;
    provider: "synapse";
} | {
    local_dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
    max_input_tokens?: number | undefined;
    provider: "local";
    model: string;
} | {
    max_input_tokens?: number | undefined;
    truncate?: string | undefined;
    query_input_type?: string | undefined;
    input_type?: string | undefined;
    api_key?: string | undefined;
    provider: "openai-compatible";
    model: string;
    endpoint: string;
} | {
    provider: "off";
}, {
    provider: "off" | "local" | "openai-compatible" | "synapse";
    fallback_provider?: "off" | "local" | "openai-compatible" | undefined;
    model?: string | undefined;
    endpoint?: string | undefined;
    api_key?: string | undefined;
    input_type?: string | undefined;
    query_input_type?: string | undefined;
    truncate?: string | undefined;
    max_input_tokens?: number | undefined;
    local_dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
}>>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type EmbeddingFallbackProvider = z.infer<typeof EmbeddingFallbackProviderSchema>;
export interface SubcConfig {
    connection_file: string;
}
export interface ShadowEmbeddingConfig {
    enabled: boolean;
}
export interface MuralConfig {
    enabled: boolean;
    /** The CUE COMPRESSOR model for the compress-cues dreamer task (the mural is
     *  now rendered deterministically, so this no longer names an author model). */
    model?: string;
}
export interface MagicContextConfig {
    enabled: boolean;
    /** User-level setting that lets a session started exactly in the canonical home directory use a deterministic directory identity. */
    allow_home_project: boolean;
    mural: MuralConfig;
    /** Selects the runtime implementation for this project. Rust mode is experimental and requires user-level subc configuration. */
    transform_mode: "ts" | "rust";
    /** Auto-update the cached OpenCode plugin wrapper when a newer npm version is available.
     *  USER config only; project configs cannot disable it. Default: true. */
    auto_update?: boolean;
    /** Output language for generated Magic Context prose. USER config only. */
    language?: string;
    historian?: HistorianConfig;
    dreamer?: DreamerConfig;
    smart_notes: {
        /** Flip ownership of authoring-compiled conditions from dreamer to retina. */
        retina_handoff: boolean;
    };
    cache_ttl: string | {
        default: string;
        [modelKey: string]: string;
    };
    /** Preset routing for guidance and provider-visible prompt surfaces. */
    prompt_surface: PromptSurfaceConfig;
    /** User-only output-token reservation override. Zero disables reservation. */
    output_reserve?: number | {
        default: number;
        [modelKey: string]: number;
    };
    /** User-only model metadata inputs. */
    models?: {
        window_overlay_path?: string;
    };
    /** TUI toast lifetime in milliseconds for Magic Context notifications. Default: 5000. */
    toast_duration_ms?: number;
    execute_threshold_percentage: number | {
        default: number;
        [modelKey: string]: number;
    };
    /** Absolute token thresholds per model. When set for a given model (or via `default`),
     *  this overrides `execute_threshold_percentage` for that model. Useful for hard caps
     *  matching provider input limits. Values above 90% × context_limit are clamped with a warning. */
    execute_threshold_tokens?: {
        default?: number;
        [modelKey: string]: number | undefined;
    };
    protected_tags: number;
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    /** Per-connection SQLite tuning for Magic Context's own context.db. */
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    /**
     * Keep shared-storage permissions under an external operator's control.
     * USER config only; project configs cannot weaken local data privacy.
     */
    storage: {
        enforce_private_permissions: boolean;
    };
    /**
     * Controls whether and where Magic Context augments the system prompt
     * (`## Magic Context` guidance, `<project-docs>`, `<user-profile>`,
     * sticky date) inside `experimental.chat.system.transform`.
     *
     * Internal OpenCode hidden agents (title, summary, compaction) are
     * always skipped automatically — that's a separate code path.
     */
    system_prompt_injection: {
        /** When false, NO injection happens for ANY agent — global escape hatch. */
        enabled: boolean;
        /**
         * If the agent's system prompt contains any of these substrings,
         * skip ALL Magic Context injection for that call. Lets users opt
         * specific agents out (e.g. read-only QA agents that deny our
         * `ctx_*` tools and don't need the guidance). The default marker
         * `<!-- magic-context: skip -->` is meant to be added inside the
         * user's custom agent prompt.
         */
        skip_signatures: string[];
    };
    /** Inject elapsed-time markers between user messages and date ranges on
     *  compartments so the agent has a wall-clock sense of the session.
     *  Graduated from `experimental.temporal_awareness`; default: true. */
    temporal_awareness: boolean;
    /** Debug: when true, keep the child sessions Magic Context spawns for its
     *  own subagents (historian, dreamer, sidekick, memory-migration) instead
     *  of deleting them on success. For short-term inspection/data collection;
     *  kept sessions accumulate until manually cleared. Default false. */
    keep_subagents: boolean;
    /**
     * When true (default), deterministic inoperability (schema fence, storage
     * open/migration failure) blocks the primary-session transform with a loud
     * recovery error instead of silently falling through to native compaction.
     * USER config only — project tier cannot set this. Not recommended to disable.
     */
    fail_closed_blocking: boolean;
    /**
     * Compaction-off mode gate. When `enabled` is false Magic Context stops
     * managing the context window and keeps only its knowledge layer, letting
     * the harness's native compaction (or nothing) own the window. USER config
     * only — project tier `compaction.enabled` is stripped for security.
     * Boot-resolved: changing it requires a process restart.
     */
    compaction: {
        enabled: boolean;
    };
    /** Pi-only controls for Magic Context's OpenCode-parity todowrite surface. */
    todowrite: {
        enabled: boolean;
        overlay: boolean;
    };
    /** Pi-only child-process extension controls. */
    pi?: PiConfig;
    /** Content-aware reclaim of tool output that a later call supersedes, added
     *  to the normal age-based auto-drop: superseded todowrite/ctx_reduce/meta
     *  outputs are dropped, and older edits to a file are compressed to a marker
     *  that keeps only the filePath. Only runs on a transform pass that is
     *  already rewriting the messages, so it never triggers a prompt-cache miss
     *  on its own; when off, the messages sent to the model are byte-identical to
     *  the age-based-only behavior. Experimental, opt-in, default off until cache
     *  stability is proven. */
    smart_drops: boolean;
    /**
     * Age-tier caveman compression for long user/assistant text parts.
     * Graduated from `experimental.caveman_text_compression`; opt-in, default off.
     *
     * Active only for primary sessions when enabled; never for subagents.
     * Buckets eligible (outside-protected-tail) messages into four age
     * tiers by tag position — oldest 20% → ultra, next 20% → full,
     * next 20% → lite, newest 40% → untouched — and rewrites the text
     * part in place.
     * Always compresses from the original source (source_contents), so
     * tier shifts produce the same result as if the target depth were
     * applied directly to the original text.
     *
     * Disabled by default because it rewrites agent-visible history.
     */
    caveman_text_compression: {
        enabled: boolean;
        /** Text parts shorter than this (characters) are left untouched. */
        min_chars: number;
    };
    embedding: EmbeddingConfig;
    /** User-only connection settings for the Synapse daemon. */
    subc?: SubcConfig;
    /** Developer-only Synapse shadow lane switch. */
    shadow_embedding?: ShadowEmbeddingConfig;
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        /** Appends a compact hint to new user messages when ctx_search finds
         *  highly-related memories, conversation, or git commits. Does NOT
         *  inject full content — just vague fragments that nudge the agent to
         *  run ctx_search for full context if relevant. Graduated from
         *  `experimental.auto_search`; enabled by default. Independent of
         *  `memory.enabled` — it can still surface conversation/git hints when
         *  the memory store is off. */
        auto_search: {
            enabled: boolean;
            /** Top hit score must exceed this threshold for the hint to fire. */
            score_threshold: number;
            /** Minimum user message length in characters (skip short prompts). */
            min_prompt_chars: number;
        };
        /** Index git commit messages from HEAD into a new ctx_search source so
         *  agents can recall recent regressions, fixes, and decisions from
         *  commit history without running git log manually. Graduated from
         *  `experimental.git_commit_indexing`; opt-in, default off. Independent
         *  of `memory.enabled`. */
        git_commit_indexing: {
            enabled: boolean;
            /** Days of history to index (default: 365) */
            since_days: number;
            /** Max commits kept per project; oldest evicted (default: 2000) */
            max_commits: number;
        };
    };
    sidekick?: SidekickConfig;
}
export declare const MagicContextConfigSchema: z.ZodPipe<z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    allow_home_project: z.ZodDefault<z.ZodBoolean>;
    mural: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        model: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    transform_mode: z.ZodDefault<z.ZodEnum<{
        ts: "ts";
        rust: "rust";
    }>>;
    auto_update: z.ZodOptional<z.ZodBoolean>;
    language: z.ZodOptional<z.ZodString>;
    historian: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        prompt: z.ZodOptional<z.ZodString>;
        tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        disable: z.ZodOptional<z.ZodBoolean>;
        description: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodEnum<{
            primary: "primary";
            subagent: "subagent";
            all: "all";
        }>>;
        color: z.ZodOptional<z.ZodString>;
        maxSteps: z.ZodOptional<z.ZodNumber>;
        permission: z.ZodOptional<z.ZodObject<{
            edit: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>]>>;
            webfetch: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            doom_loop: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            external_directory: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
        }, z.core.$strip>>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        variant: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        two_pass: z.ZodDefault<z.ZodBoolean>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
        disallowed_tools: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "*": "*";
            read: "read";
            aft_outline: "aft_outline";
            aft_zoom: "aft_zoom";
            aft_search: "aft_search";
        }>>>;
    }, z.core.$strip>>;
    dreamer: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        prompt: z.ZodOptional<z.ZodString>;
        tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        disable: z.ZodOptional<z.ZodBoolean>;
        description: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodEnum<{
            primary: "primary";
            subagent: "subagent";
            all: "all";
        }>>;
        color: z.ZodOptional<z.ZodString>;
        maxSteps: z.ZodOptional<z.ZodNumber>;
        permission: z.ZodOptional<z.ZodObject<{
            edit: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>]>>;
            webfetch: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            doom_loop: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            external_directory: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
        }, z.core.$strip>>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        variant: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        tasks: z.ZodDefault<z.ZodObject<{
            "map-memories": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            verify: z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "verify-broad": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            curate: z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "compress-cues": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "classify-memories": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            retrospective: z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "maintain-docs": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "evaluate-smart-notes": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
            "review-user-memories": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
                promotion_threshold: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            "promote-primers": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
                promotion_threshold: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strip>>;
            "refresh-primers": z.ZodDefault<z.ZodObject<{
                schedule: z.ZodDefault<z.ZodString>;
                model: z.ZodOptional<z.ZodString>;
                fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
                thinking_level: z.ZodOptional<z.ZodEnum<{
                    off: "off";
                    minimal: "minimal";
                    low: "low";
                    medium: "medium";
                    high: "high";
                    xhigh: "xhigh";
                    max: "max";
                }>>;
                timeout_minutes: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        inject_docs: z.ZodDefault<z.ZodBoolean>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
    }, z.core.$strip>>;
    smart_notes: z.ZodDefault<z.ZodObject<{
        retina_handoff: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    cache_ttl: z.ZodDefault<z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
        default: z.ZodString;
    }, z.core.$catchall<z.ZodString>>]>>;
    prompt_surface: z.ZodDefault<z.ZodObject<{
        default: z.ZodDefault<z.ZodEnum<{
            full: "full";
            light: "light";
        }>>;
        models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodEnum<{
            full: "full";
            light: "light";
        }>>>;
        guidance_override_path: z.ZodOptional<z.ZodString>;
        tool_descriptions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
    output_reserve: z.ZodOptional<z.ZodUnion<readonly [z.ZodNumber, z.ZodObject<{
        default: z.ZodNumber;
    }, z.core.$catchall<z.ZodNumber>>]>>;
    models: z.ZodOptional<z.ZodObject<{
        window_overlay_path: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    toast_duration_ms: z.ZodDefault<z.ZodNumber>;
    execute_threshold_percentage: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodObject<{
        default: z.ZodNumber;
    }, z.core.$catchall<z.ZodNumber>>]>>;
    execute_threshold_tokens: z.ZodOptional<z.ZodObject<{
        default: z.ZodOptional<z.ZodNumber>;
    }, z.core.$catchall<z.ZodNumber>>>;
    protected_tags: z.ZodOptional<z.ZodNumber>;
    clear_reasoning_age: z.ZodDefault<z.ZodNumber>;
    history_budget_percentage: z.ZodDefault<z.ZodNumber>;
    historian_timeout_ms: z.ZodDefault<z.ZodNumber>;
    commit_cluster_trigger: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        min_clusters: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    system_prompt_injection: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        skip_signatures: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    sqlite: z.ZodDefault<z.ZodObject<{
        cache_size_mb: z.ZodDefault<z.ZodNumber>;
        mmap_size_mb: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    storage: z.ZodDefault<z.ZodObject<{
        enforce_private_permissions: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    embedding: z.ZodDefault<z.ZodPipe<z.ZodObject<{
        provider: z.ZodDefault<z.ZodEnum<{
            off: "off";
            local: "local";
            "openai-compatible": "openai-compatible";
            synapse: "synapse";
        }>>;
        fallback_provider: z.ZodOptional<z.ZodEnum<{
            off: "off";
            local: "local";
            "openai-compatible": "openai-compatible";
        }>>;
        model: z.ZodOptional<z.ZodString>;
        endpoint: z.ZodOptional<z.ZodString>;
        api_key: z.ZodOptional<z.ZodString>;
        input_type: z.ZodOptional<z.ZodString>;
        query_input_type: z.ZodOptional<z.ZodString>;
        truncate: z.ZodOptional<z.ZodString>;
        max_input_tokens: z.ZodOptional<z.ZodNumber>;
        local_dtype: z.ZodOptional<z.ZodEnum<{
            auto: "auto";
            fp32: "fp32";
            fp16: "fp16";
            q8: "q8";
            int8: "int8";
            uint8: "uint8";
            q4: "q4";
            bnb4: "bnb4";
            q4f16: "q4f16";
            q2: "q2";
            q2f16: "q2f16";
            q1: "q1";
            q1f16: "q1f16";
        }>>;
    }, z.core.$strip>, z.ZodTransform<{
        max_input_tokens?: number | undefined;
        truncate?: string | undefined;
        query_input_type?: string | undefined;
        input_type?: string | undefined;
        api_key?: string | undefined;
        endpoint?: string | undefined;
        model?: string | undefined;
        fallback_provider?: "off" | "local" | "openai-compatible" | undefined;
        provider: "synapse";
    } | {
        local_dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
        max_input_tokens?: number | undefined;
        provider: "local";
        model: string;
    } | {
        max_input_tokens?: number | undefined;
        truncate?: string | undefined;
        query_input_type?: string | undefined;
        input_type?: string | undefined;
        api_key?: string | undefined;
        provider: "openai-compatible";
        model: string;
        endpoint: string;
    } | {
        provider: "off";
    }, {
        provider: "off" | "local" | "openai-compatible" | "synapse";
        fallback_provider?: "off" | "local" | "openai-compatible" | undefined;
        model?: string | undefined;
        endpoint?: string | undefined;
        api_key?: string | undefined;
        input_type?: string | undefined;
        query_input_type?: string | undefined;
        truncate?: string | undefined;
        max_input_tokens?: number | undefined;
        local_dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
    }>>>;
    subc: z.ZodOptional<z.ZodObject<{
        connection_file: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    }, z.core.$strip>>;
    shadow_embedding: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    temporal_awareness: z.ZodDefault<z.ZodBoolean>;
    keep_subagents: z.ZodDefault<z.ZodBoolean>;
    fail_closed_blocking: z.ZodDefault<z.ZodBoolean>;
    compaction: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    todowrite: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        overlay: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    pi: z.ZodOptional<z.ZodObject<{
        subagent_extensions: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    smart_drops: z.ZodDefault<z.ZodBoolean>;
    caveman_text_compression: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        min_chars: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    memory: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        injection_budget_tokens: z.ZodDefault<z.ZodNumber>;
        auto_promote: z.ZodDefault<z.ZodBoolean>;
        retrieval_count_promotion_threshold: z.ZodDefault<z.ZodNumber>;
        auto_search: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            score_threshold: z.ZodDefault<z.ZodNumber>;
            min_prompt_chars: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
        git_commit_indexing: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            since_days: z.ZodDefault<z.ZodNumber>;
            max_commits: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    sidekick: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        temperature: z.ZodOptional<z.ZodNumber>;
        top_p: z.ZodOptional<z.ZodNumber>;
        prompt: z.ZodOptional<z.ZodString>;
        tools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
        disable: z.ZodOptional<z.ZodBoolean>;
        description: z.ZodOptional<z.ZodString>;
        mode: z.ZodOptional<z.ZodEnum<{
            primary: "primary";
            subagent: "subagent";
            all: "all";
        }>>;
        color: z.ZodOptional<z.ZodString>;
        maxSteps: z.ZodOptional<z.ZodNumber>;
        permission: z.ZodOptional<z.ZodObject<{
            edit: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            bash: z.ZodOptional<z.ZodUnion<readonly [z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>, z.ZodRecord<z.ZodString, z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>]>>;
            webfetch: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            doom_loop: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
            external_directory: z.ZodOptional<z.ZodEnum<{
                deny: "deny";
                allow: "allow";
                ask: "ask";
            }>>;
        }, z.core.$strip>>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        variant: z.ZodOptional<z.ZodString>;
        fallback_models: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodArray<z.ZodString>]>>;
        timeout_ms: z.ZodDefault<z.ZodNumber>;
        system_prompt: z.ZodOptional<z.ZodString>;
        thinking_level: z.ZodOptional<z.ZodEnum<{
            off: "off";
            minimal: "minimal";
            low: "low";
            medium: "medium";
            high: "high";
            xhigh: "xhigh";
            max: "max";
        }>>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodTransform<MagicContextConfig, {
    enabled: boolean;
    allow_home_project: boolean;
    mural: {
        enabled: boolean;
        model?: string | undefined;
    };
    transform_mode: "ts" | "rust";
    smart_notes: {
        retina_handoff: boolean;
    };
    cache_ttl: string | {
        [x: string]: string;
        default: string;
    };
    prompt_surface: {
        default: "full" | "light";
        models?: Record<string, "full" | "light"> | undefined;
        guidance_override_path?: string | undefined;
        tool_descriptions?: Record<string, string> | undefined;
    };
    toast_duration_ms: number;
    execute_threshold_percentage: number | {
        [x: string]: number;
        default: number;
    };
    clear_reasoning_age: number;
    history_budget_percentage: number;
    historian_timeout_ms: number;
    commit_cluster_trigger: {
        enabled: boolean;
        min_clusters: number;
    };
    system_prompt_injection: {
        enabled: boolean;
        skip_signatures: string[];
    };
    sqlite: {
        cache_size_mb: number;
        mmap_size_mb: number;
    };
    storage: {
        enforce_private_permissions: boolean;
    };
    embedding: {
        max_input_tokens?: number | undefined;
        truncate?: string | undefined;
        query_input_type?: string | undefined;
        input_type?: string | undefined;
        api_key?: string | undefined;
        endpoint?: string | undefined;
        model?: string | undefined;
        fallback_provider?: "off" | "local" | "openai-compatible" | undefined;
        provider: "synapse";
    } | {
        local_dtype?: "auto" | "fp32" | "fp16" | "q8" | "int8" | "uint8" | "q4" | "bnb4" | "q4f16" | "q2" | "q2f16" | "q1" | "q1f16" | undefined;
        max_input_tokens?: number | undefined;
        provider: "local";
        model: string;
    } | {
        max_input_tokens?: number | undefined;
        truncate?: string | undefined;
        query_input_type?: string | undefined;
        input_type?: string | undefined;
        api_key?: string | undefined;
        provider: "openai-compatible";
        model: string;
        endpoint: string;
    } | {
        provider: "off";
    };
    shadow_embedding: {
        enabled: boolean;
    };
    temporal_awareness: boolean;
    keep_subagents: boolean;
    fail_closed_blocking: boolean;
    compaction: {
        enabled: boolean;
    };
    todowrite: {
        enabled: boolean;
        overlay: boolean;
    };
    smart_drops: boolean;
    caveman_text_compression: {
        enabled: boolean;
        min_chars: number;
    };
    memory: {
        enabled: boolean;
        injection_budget_tokens: number;
        auto_promote: boolean;
        retrieval_count_promotion_threshold: number;
        auto_search: {
            enabled: boolean;
            score_threshold: number;
            min_prompt_chars: number;
        };
        git_commit_indexing: {
            enabled: boolean;
            since_days: number;
            max_commits: number;
        };
    };
    auto_update?: boolean | undefined;
    language?: string | undefined;
    historian?: {
        two_pass: boolean;
        disallowed_tools: ("*" | "read" | "aft_outline" | "aft_zoom" | "aft_search")[];
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "primary" | "subagent" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
    } | undefined;
    dreamer?: {
        tasks: {
            "map-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            verify: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "verify-broad": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            curate: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "compress-cues": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "classify-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            retrospective: {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "maintain-docs": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "evaluate-smart-notes": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
            "review-user-memories": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
                promotion_threshold?: number | undefined;
            };
            "promote-primers": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
                promotion_threshold?: number | undefined;
            };
            "refresh-primers": {
                schedule: string;
                timeout_minutes: number;
                model?: string | undefined;
                fallback_models?: string | string[] | undefined;
                thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
            };
        };
        inject_docs: boolean;
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "primary" | "subagent" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
    } | undefined;
    output_reserve?: number | {
        [x: string]: number;
        default: number;
    } | undefined;
    models?: {
        window_overlay_path?: string | undefined;
    } | undefined;
    execute_threshold_tokens?: {
        [x: string]: number;
        default?: number | undefined;
    } | undefined;
    protected_tags?: number | undefined;
    subc?: {
        connection_file: string;
    } | undefined;
    pi?: {
        subagent_extensions?: string[] | undefined;
    } | undefined;
    sidekick?: {
        timeout_ms: number;
        model?: string | undefined;
        temperature?: number | undefined;
        top_p?: number | undefined;
        prompt?: string | undefined;
        tools?: Record<string, boolean> | undefined;
        disable?: boolean | undefined;
        description?: string | undefined;
        mode?: "primary" | "subagent" | "all" | undefined;
        color?: string | undefined;
        maxSteps?: number | undefined;
        permission?: {
            edit?: "deny" | "allow" | "ask" | undefined;
            bash?: "deny" | "allow" | "ask" | Record<string, "deny" | "allow" | "ask"> | undefined;
            webfetch?: "deny" | "allow" | "ask" | undefined;
            doom_loop?: "deny" | "allow" | "ask" | undefined;
            external_directory?: "deny" | "allow" | "ask" | undefined;
        } | undefined;
        maxTokens?: number | undefined;
        variant?: string | undefined;
        fallback_models?: string | string[] | undefined;
        system_prompt?: string | undefined;
        thinking_level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
    } | undefined;
}>>;
//# sourceMappingURL=magic-context.d.ts.map