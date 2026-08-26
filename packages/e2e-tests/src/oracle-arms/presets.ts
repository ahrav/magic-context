import type { TestHarnessOptions } from "../harness";
import type { SpawnOptions } from "../opencode-runner/spawn";

export function mcOffOptions(): TestHarnessOptions {
    return { openCodeConfigExtra: { plugin: [] } };
}

export function naiveCompactionOptions(): TestHarnessOptions {
    return { openCodeConfigExtra: { compaction: { auto: true } } };
}

export interface LiveModelOptions {
    apiKey: string;
    providerBlock: Record<string, unknown>;
}

/**
 * Build the live-model portion of `SpawnOptions`.
 *
 * `openCodeConfigExtra` is shallowly spread over the generated config, so this
 * provider map replaces the default map. Prompt-sending callers that still use
 * the mock provider must include `mock-anthropic` beside the live provider.
 * `RustTestHarness.restart()` also drops `openCodeConfigExtra`, so callers must
 * not expect this recipe to survive a restart.
 */
export function liveModelSpawnOptions({
    apiKey,
    providerBlock,
}: LiveModelOptions): Pick<SpawnOptions, "extraEnv" | "openCodeConfigExtra"> {
    return {
        extraEnv: { ANTHROPIC_API_KEY: apiKey },
        openCodeConfigExtra: { provider: providerBlock },
    };
}
