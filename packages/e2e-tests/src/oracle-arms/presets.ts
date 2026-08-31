import type { TestHarnessOptions } from "../harness";
import type { SpawnOptions } from "../opencode-runner/spawn";

export function mcOffOptions(): TestHarnessOptions {
    return { openCodeConfigExtra: { plugin: [] } };
}

export function naiveCompactionOptions(): TestHarnessOptions {
    return { openCodeConfigExtra: { compaction: { auto: true, prune: false } } };
}

export interface LiveModelOptions {
    apiKey: string;
    providerBlock: Record<string, unknown>;
}

/**
 * Build the live-model portion of `SpawnOptions`.
 *
 * `openCodeConfigExtra.provider` is merged beside the generated mock provider.
 * `RustTestHarness.restart()` also drops `openCodeConfigExtra`, so callers must
 * not expect this recipe to survive a restart.
 *
 * The recipe pins `hostname` to loopback: the serve HTTP API is
 * unauthenticated, and this is the one spawn path that places a real
 * `ANTHROPIC_API_KEY` in the child env. Binding all interfaces here would let
 * anyone who can reach the port drive sessions against the live credential.
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
