/**
 */
export const COMPACTION_ENABLED_PATH = `compaction${"."}enabled`;

export function isDreamerRunnable(config: { dreamer?: { disable?: boolean } | null }): boolean {
    return !!config.dreamer && config.dreamer.disable !== true;
}

export function isSidekickRunnable(config: { sidekick?: { disable?: boolean } | null }): boolean {
    return !!config.sidekick && config.sidekick.disable !== true;
}

export function isHistorianRunnable(config: { historian?: { disable?: boolean } | null }): boolean {
    return config.historian?.disable !== true;
}

/**
 */
export function isCompactionEnabled(config: {
    compaction?: { enabled?: boolean } | null;
}): boolean {
    return config.compaction?.enabled !== false;
}

function clonePlainObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return { ...(value as Record<string, unknown>) };
}

function migrateLegacyEnabledForAgent(args: {
    patched: Record<string, unknown>;
    agentName: "dreamer" | "sidekick" | "historian";
    warnings: string[];
}): void {
    const agent = clonePlainObject(args.patched[args.agentName]);
    if (!agent || !("enabled" in agent)) return;

    const enabled = agent.enabled;
    const disable = agent.disable;
    delete agent.enabled;

    if (args.agentName === "historian") {
        args.warnings.push(
            'Removed invalid "historian.enabled" in-memory (run doctor to persist).',
        );
        args.patched.historian = agent;
        return;
    }

    if (args.agentName === "dreamer") {
        if (disable !== true && enabled === false) {
            agent.disable = true;
            args.warnings.push(
                'Migrated "dreamer.enabled=false" → "dreamer.disable=true" in-memory (run doctor to persist). This now also disables manual /ctx-dream; for manual-only remove disable and set schedule="".',
            );
        }
        // `enabled=true` has no effect because only `disable=true` disables Dreamer; remove it without warning.
        args.patched.dreamer = agent;
        return;
    }

    if (disable !== true && enabled === false) {
        agent.disable = true;
        args.warnings.push(
            'Migrated "sidekick.enabled=false" → "sidekick.disable=true" in-memory (run doctor to persist).',
        );
    }
    // `enabled=true` has no effect because only `disable=true` disables Sidekick; remove it without warning.
    args.patched.sidekick = agent;
}

export function migrateLegacyAgentEnabledInMemory(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const shouldPatch = ["dreamer", "sidekick", "historian"].some((key) => {
        const agent = rawConfig[key];
        return (
            typeof agent === "object" &&
            agent !== null &&
            !Array.isArray(agent) &&
            "enabled" in agent
        );
    });
    if (!shouldPatch) return rawConfig;

    const patched: Record<string, unknown> = { ...rawConfig };
    migrateLegacyEnabledForAgent({ patched, agentName: "dreamer", warnings });
    migrateLegacyEnabledForAgent({ patched, agentName: "sidekick", warnings });
    migrateLegacyEnabledForAgent({ patched, agentName: "historian", warnings });
    return patched;
}
