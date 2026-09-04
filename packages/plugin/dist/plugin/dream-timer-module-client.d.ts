import type { AuthorityStatus } from "../features/magic-context/context-authority";
import type { ClassifyModuleClient } from "../features/magic-context/dreamer/classify";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";
export type DreamTimerModuleClient = ClassifyModuleClient & {
    authorityStatus?: (args: {
        context_store_uuid: string;
        project: string;
        projectRoot?: string;
        domain: "memories" | "notes";
    }) => Promise<{
        authority: AuthorityStatus | null;
    }>;
};
/**
 * Adapt the Rust transport without extracting methods from its class instance.
 * mc-host transports read instance routing state, so every forwarded call must retain `this`.
 */
export declare function createDreamTimerModuleClient(moduleClient: RustModeModuleClient | undefined): DreamTimerModuleClient | undefined;
//# sourceMappingURL=dream-timer-module-client.d.ts.map