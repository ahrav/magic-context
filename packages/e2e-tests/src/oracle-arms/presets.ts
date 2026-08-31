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
 *
 *
 * `hostname` is `127.0.0.1` to restrict the server to loopback.
 */
export function liveModelSpawnOptions({
    apiKey,
    providerBlock,
}: LiveModelOptions): Pick<SpawnOptions, "extraEnv" | "openCodeConfigExtra" | "hostname"> {
    return {
        extraEnv: { ANTHROPIC_API_KEY: apiKey },
        openCodeConfigExtra: { provider: providerBlock },
        hostname: "127.0.0.1",
    };
}
