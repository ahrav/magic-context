import { DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE } from "./schema/magic-context";

/**
 *
 * A project config belongs to the cloned repository and is untrusted.
 * A repository config must never escalate privilege or exfiltrate secrets.
 * The project-config sanitizers run before and after repository config is merged over trusted user config.
 * The project-config sanitizers mutate raw project config in place and return human-readable warnings.
 * human-readable warnings.
 *
 */

/** These hidden agents run with elevated or autonomous capability. */
const HIDDEN_AGENT_KEYS = ["historian", "dreamer", "sidekick"] as const;
const HISTORIAN_USER_ONLY_FIELDS = ["model", "fallback_models"] as const;
const PROMPT_SURFACE_USER_ONLY_FIELDS = ["guidance_override_path", "tool_descriptions"] as const;

/**
 * An untrusted repository must not set these hidden-agent fields because they can escalate privileges or execute code.
 *
 * A repository-supplied `prompt` can reprogram Dreamer, which runs autonomously with `bash`, `edit`, and `webfetch`, enabling unattended exfiltration or code execution.
 *  - `permission` — broadens the agent's per-tool permissions.
 * `tools` can enable a denied tool such as `bash` for an agent whose allow-list excludes it.
 * `system_prompt` takes precedence over Sidekick's built-in prompt, so a repository could reprogram Sidekick through `/ctx-aug` unless it is stripped.
 *                   via `/ctx-aug`.
 *
 * Dreamer model and cadence fields remain allowed so a repository can tune its overlays and schedules through the user's provider authentication.
 * Historian model selection is user-only, and project compaction thresholds can only increase, preventing cloned repositories from forcing earlier compaction or extra Historian spending.
 */
const AGENT_ESCALATION_FIELDS = ["prompt", "permission", "tools", "system_prompt"] as const;
const EMBEDDING_DESTINATION_FIELDS = ["endpoint", "provider", "fallback_provider"] as const;
const PERCENTAGE_THRESHOLD_REASON =
    "security: a repository may only raise compaction thresholds above the user's effective value; it cannot force earlier historian work or cloned-repo cost escalation.";
const TOKEN_THRESHOLD_REASON =
    "security: a repository may only raise execute_threshold_tokens above the user's trusted token threshold; it cannot force earlier historian work or cloned-repo cost escalation.";
const TOKEN_THRESHOLD_INTRODUCTION_REASON =
    "security: a repository cannot introduce a new execute_threshold_tokens override when the user has no trusted token threshold for that key; that could force earlier historian work or cloned-repo cost escalation.";

interface PercentageThresholdConfig {
    defaultValue: number;
    overrides: Map<string, number>;
}

interface TokenThresholdConfig {
    defaultValue: number | undefined;
    overrides: Map<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPercentageThreshold(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 20 && value <= 80;
}

function isValidTokenThreshold(value: unknown): value is number {
    return (
        typeof value === "number" && Number.isFinite(value) && value >= 5_000 && value <= 2_000_000
    );
}

function normalizeTrustedPercentageThresholds(value: unknown): PercentageThresholdConfig {
    if (typeof value === "number" && Number.isFinite(value)) {
        return { defaultValue: value, overrides: new Map() };
    }

    if (
        isPlainObject(value) &&
        typeof value.default === "number" &&
        Number.isFinite(value.default)
    ) {
        const overrides = new Map<string, number>();
        for (const [key, child] of Object.entries(value)) {
            if (key === "default") continue;
            if (typeof child === "number" && Number.isFinite(child)) {
                overrides.set(key, child);
            }
        }
        return { defaultValue: value.default, overrides };
    }

    return { defaultValue: DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE, overrides: new Map() };
}

function normalizeTrustedTokenThresholds(value: unknown): TokenThresholdConfig {
    if (!isPlainObject(value)) {
        return { defaultValue: undefined, overrides: new Map() };
    }

    const overrides = new Map<string, number>();
    for (const [key, child] of Object.entries(value)) {
        if (key === "default") continue;
        if (typeof child === "number" && Number.isFinite(child)) {
            overrides.set(key, child);
        }
    }

    return {
        defaultValue:
            typeof value.default === "number" && Number.isFinite(value.default)
                ? value.default
                : undefined,
        overrides,
    };
}

function clonePercentageThresholds(value: PercentageThresholdConfig): PercentageThresholdConfig {
    return {
        defaultValue: value.defaultValue,
        overrides: new Map(value.overrides),
    };
}

function cloneTokenThresholds(value: TokenThresholdConfig): TokenThresholdConfig {
    return {
        defaultValue: value.defaultValue,
        overrides: new Map(value.overrides),
    };
}

function percentageThresholdsEqual(
    left: PercentageThresholdConfig,
    right: PercentageThresholdConfig,
): boolean {
    if (left.defaultValue !== right.defaultValue) return false;
    if (left.overrides.size !== right.overrides.size) return false;
    for (const [key, value] of left.overrides) {
        if (right.overrides.get(key) !== value) return false;
    }
    return true;
}

function setMergedPercentageThreshold(
    mergedRaw: Record<string, unknown>,
    value: PercentageThresholdConfig,
): void {
    if (value.overrides.size === 0) {
        mergedRaw.execute_threshold_percentage = value.defaultValue;
        return;
    }

    const serialized: Record<string, number> = { default: value.defaultValue };
    for (const [key, threshold] of value.overrides) {
        serialized[key] = threshold;
    }
    mergedRaw.execute_threshold_percentage = serialized;
}

function setMergedTokenThreshold(
    mergedRaw: Record<string, unknown>,
    value: TokenThresholdConfig,
): void {
    if (value.defaultValue === undefined && value.overrides.size === 0) {
        delete mergedRaw.execute_threshold_tokens;
        return;
    }

    const serialized: Record<string, number> = {};
    if (value.defaultValue !== undefined) {
        serialized.default = value.defaultValue;
    }
    for (const [key, threshold] of value.overrides) {
        serialized[key] = threshold;
    }
    mergedRaw.execute_threshold_tokens = serialized;
}

function makeProjectThresholdWarning(field: string, reason: string): string {
    return `Ignoring ${field} from project config (${reason})`;
}

/**
 *
 * Closes:
 * A repository must not suppress plugin self-updates because updates can carry security fixes.
 * A repository must not change `fail_closed_blocking`, which can unblock or force-block the loud inoperability gate.
 * Only user config may set `fail_closed_blocking` to `false`.
 * `allow_home_project` may establish a durable project identity only from user config.
 * Only user config may change `output_reserve` or `models.window_overlay_path`.
 *  - `language`: a repo must not inject prompt text through a user preference.
 * Only user config may set `sqlite` because its settings apply as PRAGMAs on the shared DB handle.
 * `sqlite` settings affect the shared DB handle used by every project in the process.
 * Project `sqlite` values could exhaust host memory or address space because they affect the shared DB handle.
 * Only user config may set `storage.enforce_private_permissions` because it changes the shared store's confidentiality.
 * Changing `storage.enforce_private_permissions` affects every session's local-memory confidentiality.
 * Only user config may enable an externally managed trusted-group deployment.
 * Only user config may set `embedding.endpoint`, `embedding.provider`, or `embedding.fallback_provider`.
 * Embedding destinations receive private memory, search, and commit text.
 * User config is the trust boundary for embedding destinations.
 * `transform_mode` may come from project config, but Rust activation also requires user-tier consent.
 * A project `transform_mode` selection can opt that project's runtime into the Rust pipeline.
 * Rust activation requires user-level `transform_mode` or trusted user-level `subc` configuration.
 * Rust can demand-start the managed native-host lifecycle only after user-tier consent.
 * Only user config may set `historian.model` or `historian.fallback_models` to prevent repositories from forcing compaction cost.
 * Only user config may set `mural.model` so repositories cannot select a provider for project memory.
 * Project config must not set `pi.subagent_extensions` because it controls extensions loaded by Pi child processes.
 * A repository may select a reviewed `prompt_surface` preset but may not set arbitrary prompt text.
 * A repository may select a reviewed `prompt_surface` preset but may not inject arbitrary guidance or tool-description text.
 * Project config must not set hidden-agent `prompt`, `permission`, or `tools`.
 */
export function stripUnsafeProjectConfigFields(projectRaw: Record<string, unknown>): string[] {
    const warnings: string[] = [];

    if ("auto_update" in projectRaw) {
        delete projectRaw.auto_update;
        warnings.push(
            "Ignoring auto_update from project config (security: this setting only honors user-level config).",
        );
    }

    if ("fail_closed_blocking" in projectRaw) {
        delete projectRaw.fail_closed_blocking;
        warnings.push(
            "Ignoring fail_closed_blocking from project config (security: only user-level config may disable or force the loud inoperability gate).",
        );
    }

    if ("allow_home_project" in projectRaw) {
        delete projectRaw.allow_home_project;
        warnings.push(
            "Ignoring allow_home_project from project config (security: only user-level config may opt the user's home directory into Magic Context).",
        );
    }

    const compaction = projectRaw.compaction;
    if (isPlainObject(compaction) && "enabled" in compaction) {
        delete compaction.enabled;
        warnings.push(
            "Ignoring compaction.enabled from project config (security: only user-level config may disable Magic Context's context-window management; a cloned repo cannot change how the user's window is owned).",
        );
    }

    if ("output_reserve" in projectRaw) {
        delete projectRaw.output_reserve;
        warnings.push(
            "Ignoring output_reserve from project config (security: output-token reservation only honors user-level config).",
        );
    }

    const models = projectRaw.models;
    if (isPlainObject(models) && "window_overlay_path" in models) {
        delete models.window_overlay_path;
        warnings.push(
            "Ignoring models.window_overlay_path from project config (security: only user-level config may select model geometry metadata).",
        );
    }

    if ("language" in projectRaw) {
        delete projectRaw.language;
        warnings.push(
            "Ignoring language from project config (security: output language is a user-level setting).",
        );
    }

    if ("sqlite" in projectRaw) {
        delete projectRaw.sqlite;
        warnings.push(
            "Ignoring sqlite.* from project config (security: SQLite cache/mmap PRAGMAs apply to the " +
                "process-global shared database handle; only user-level config may set them).",
        );
    }

    const storage = projectRaw.storage;
    if (isPlainObject(storage) && "enforce_private_permissions" in storage) {
        delete storage.enforce_private_permissions;
        warnings.push(
            "Ignoring storage.enforce_private_permissions from project config (security: only user-level config may opt into externally managed shared storage permissions).",
        );
    }

    const promptSurface = projectRaw.prompt_surface;
    if (isPlainObject(promptSurface)) {
        const removed: string[] = [];
        for (const field of PROMPT_SURFACE_USER_ONLY_FIELDS) {
            if (field in promptSurface) {
                delete promptSurface[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring prompt_surface.${removed.join("/")} from project config (security: repositories may select prompt presets but only user config may provide guidance or tool-description text).`,
            );
        }
    }

    const pi = projectRaw.pi;
    if (isPlainObject(pi) && "subagent_extensions" in pi) {
        delete pi.subagent_extensions;
        warnings.push(
            "Ignoring pi.subagent_extensions from project config (security: only user-level config may choose extensions loaded by Pi subagent children).",
        );
    }

    for (const field of ["subc", "shadow_embedding"] as const) {
        if (field in projectRaw) {
            delete projectRaw[field];
            warnings.push(
                `Ignoring ${field} from project config (security: daemon routing and developer-only embedding traffic are user-level settings).`,
            );
        }
    }

    const embedding = projectRaw.embedding;
    if (isPlainObject(embedding)) {
        const removed: string[] = [];
        for (const field of EMBEDDING_DESTINATION_FIELDS) {
            if (field in embedding) {
                delete embedding[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring embedding.${removed.join("/")} from project config ` +
                    "(security: a repository cannot choose where private text is embedded).",
            );
        }
    }

    const historian = projectRaw.historian;
    if (isPlainObject(historian)) {
        const removed: string[] = [];
        for (const field of HISTORIAN_USER_ONLY_FIELDS) {
            if (field in historian) {
                delete historian[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring historian.${removed.join("/")} from project config ` +
                    "(security: historian model selection is user-level only; a repository cannot force extra compaction cost).",
            );
        }
    }

    const mural = projectRaw.mural;
    if (isPlainObject(mural) && "model" in mural) {
        delete mural.model;
        warnings.push(
            "Ignoring mural.model from project config (security: the mural cue-compressor model is a user-level setting; a repository cannot choose where project memory is sent).",
        );
    }

    // model check.
    const experimental = projectRaw.experimental;
    const legacyMural = isPlainObject(experimental) ? experimental.mural : undefined;
    if (isPlainObject(legacyMural) && "model" in legacyMural) {
        delete legacyMural.model;
        warnings.push(
            "Ignoring experimental.mural.model from project config (security: the mural cue-compressor model is a user-level setting; use user-level mural.model).",
        );
    }

    for (const agentKey of HIDDEN_AGENT_KEYS) {
        const block = projectRaw[agentKey];
        if (!isPlainObject(block)) continue;
        const removed: string[] = [];
        for (const field of AGENT_ESCALATION_FIELDS) {
            if (field in block) {
                delete block[field];
                removed.push(field);
            }
        }
        if (removed.length > 0) {
            warnings.push(
                `Ignoring ${agentKey}.${removed.join("/")} from project config ` +
                    "(security: a repository cannot reprogram or re-permission hidden agents).",
            );
        }
    }

    return warnings;
}

/**
 */
export function constrainProjectThresholdOverrides(args: {
    mergedRaw: Record<string, unknown>;
    projectRaw: Record<string, unknown>;
    trustedBaseConfig: {
        execute_threshold_percentage?: unknown;
        execute_threshold_tokens?: unknown;
    };
}): string[] {
    const warnings: string[] = [];
    const basePercentage = normalizeTrustedPercentageThresholds(
        args.trustedBaseConfig.execute_threshold_percentage,
    );
    const baseTokens = normalizeTrustedTokenThresholds(
        args.trustedBaseConfig.execute_threshold_tokens,
    );

    if ("execute_threshold_percentage" in args.projectRaw) {
        const projectValue = args.projectRaw.execute_threshold_percentage;

        if (isValidPercentageThreshold(projectValue)) {
            const constrained = clonePercentageThresholds(basePercentage);
            constrained.defaultValue = Math.max(basePercentage.defaultValue, projectValue);
            for (const [modelKey, threshold] of basePercentage.overrides) {
                const raisedThreshold = Math.max(threshold, projectValue);
                if (raisedThreshold === constrained.defaultValue) {
                    constrained.overrides.delete(modelKey);
                } else {
                    constrained.overrides.set(modelKey, raisedThreshold);
                }
            }
            setMergedPercentageThreshold(args.mergedRaw, constrained);
            if (percentageThresholdsEqual(constrained, basePercentage)) {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_percentage",
                        PERCENTAGE_THRESHOLD_REASON,
                    ),
                );
            }
        } else if (isPlainObject(projectValue)) {
            const constrained = clonePercentageThresholds(basePercentage);
            let touchedValidEntry = false;

            if (isValidPercentageThreshold(projectValue.default)) {
                touchedValidEntry = true;
                if (projectValue.default > basePercentage.defaultValue) {
                    constrained.defaultValue = projectValue.default;
                } else {
                    warnings.push(
                        makeProjectThresholdWarning(
                            "execute_threshold_percentage.default",
                            PERCENTAGE_THRESHOLD_REASON,
                        ),
                    );
                }
            }

            for (const [modelKey, rawValue] of Object.entries(projectValue)) {
                if (modelKey === "default") continue;
                if (!isValidPercentageThreshold(rawValue)) continue;
                touchedValidEntry = true;
                const baseValue =
                    basePercentage.overrides.get(modelKey) ?? basePercentage.defaultValue;
                if (rawValue > baseValue) {
                    if (rawValue === constrained.defaultValue) {
                        constrained.overrides.delete(modelKey);
                    } else {
                        constrained.overrides.set(modelKey, rawValue);
                    }
                } else {
                    warnings.push(
                        makeProjectThresholdWarning(
                            `execute_threshold_percentage.${modelKey}`,
                            PERCENTAGE_THRESHOLD_REASON,
                        ),
                    );
                }
            }

            if (touchedValidEntry) {
                setMergedPercentageThreshold(args.mergedRaw, constrained);
            }
        }
    }

    if (
        "execute_threshold_tokens" in args.projectRaw &&
        isPlainObject(args.projectRaw.execute_threshold_tokens)
    ) {
        const projectValue = args.projectRaw.execute_threshold_tokens;
        const constrained = cloneTokenThresholds(baseTokens);
        let touchedValidEntry = false;

        if (isValidTokenThreshold(projectValue.default)) {
            touchedValidEntry = true;
            if (baseTokens.defaultValue === undefined) {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_tokens.default",
                        TOKEN_THRESHOLD_INTRODUCTION_REASON,
                    ),
                );
            } else if (projectValue.default > baseTokens.defaultValue) {
                constrained.defaultValue = projectValue.default;
            } else {
                warnings.push(
                    makeProjectThresholdWarning(
                        "execute_threshold_tokens.default",
                        TOKEN_THRESHOLD_REASON,
                    ),
                );
            }
        }

        for (const [modelKey, rawValue] of Object.entries(projectValue)) {
            if (modelKey === "default") continue;
            if (!isValidTokenThreshold(rawValue)) continue;
            touchedValidEntry = true;
            const baseValue = baseTokens.overrides.get(modelKey) ?? baseTokens.defaultValue;
            if (baseValue === undefined) {
                warnings.push(
                    makeProjectThresholdWarning(
                        `execute_threshold_tokens.${modelKey}`,
                        TOKEN_THRESHOLD_INTRODUCTION_REASON,
                    ),
                );
                continue;
            }
            if (rawValue > baseValue) {
                if (rawValue === constrained.defaultValue) {
                    constrained.overrides.delete(modelKey);
                } else {
                    constrained.overrides.set(modelKey, rawValue);
                }
            } else {
                warnings.push(
                    makeProjectThresholdWarning(
                        `execute_threshold_tokens.${modelKey}`,
                        TOKEN_THRESHOLD_REASON,
                    ),
                );
            }
        }

        if (touchedValidEntry) {
            setMergedTokenThreshold(args.mergedRaw, constrained);
        }
    }

    return warnings;
}

/**
 *
 *
 */
function normalizeEndpoint(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

export function dropInheritedEmbeddingKeyOnRedirect(
    projectRaw: Record<string, unknown>,
    mergedRaw: Record<string, unknown>,
    userRaw?: Record<string, unknown>,
): string[] {
    const projectEmbedding = projectRaw.embedding;
    if (!isPlainObject(projectEmbedding)) return [];

    const redirectsEndpoint = "endpoint" in projectEmbedding;
    if (!redirectsEndpoint) return [];

    const userEmbedding = userRaw?.embedding;
    if (isPlainObject(userEmbedding)) {
        const projectEndpoint = normalizeEndpoint(projectEmbedding.endpoint);
        const userEndpoint = normalizeEndpoint(userEmbedding.endpoint);
        if (projectEndpoint !== undefined && projectEndpoint === userEndpoint) {
            return [];
        }
    }

    const providesOwnKey =
        typeof projectEmbedding.api_key === "string" && projectEmbedding.api_key.length > 0;
    if (providesOwnKey) return [];

    const mergedEmbedding = mergedRaw.embedding;
    if (!isPlainObject(mergedEmbedding)) return [];
    if (!("api_key" in mergedEmbedding)) return [];

    delete mergedEmbedding.api_key;
    return [
        "Dropped inherited user embedding api_key because project config redirected " +
            "embedding.endpoint without supplying its own key (security: prevents key " +
            "exfiltration to a repository-chosen endpoint).",
    ];
}
