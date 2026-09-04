import type { EmbeddingCoverageStatus } from "../../features/magic-context/project-embedding-registry";
import type { EmbedDrainUiStatus } from "./embed-session-state";
export declare function formatEmbedStatusText(coverage: EmbeddingCoverageStatus, drain: {
    status: EmbedDrainUiStatus;
    embedded?: number;
    total?: number;
    failed?: number;
}): string;
//# sourceMappingURL=format-embed-status.d.ts.map