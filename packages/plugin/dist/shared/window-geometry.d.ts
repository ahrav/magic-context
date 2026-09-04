import type { ModelLimit } from "./models-dev-cache";
export declare const WINDOW_OVERLAY_SCHEMA = "fusiform-window-overlay/v1";
export declare const PROMPT_WALL_MARGIN = 4096;
export declare const PI_OUTPUT_FLOOR = 4096;
export declare const OPENCODE_OUTPUT_CAP = 32000;
export type WindowGeometry = "shared_upfront" | "shared_truncating" | "separate";
export type WindowReserveSource = "output_catalog" | "output_config" | "wall_margin" | "none";
export type WindowOverlayGrade = "provider_asserted_runtime" | "measured" | "provider_asserted_doc" | "catalog" | "unknown";
export type WindowOverlayUnits = "provider" | "estimate";
export type WindowOverlayBoundary = "Observed" | "Asserted" | "Corrected";
export type WindowOverlayUnknownWhy = "placeholder_output_equals_context" | "placeholder_zero" | "never_measured" | "not_single_valued_at_key" | "retracted";
export type WindowOverlayFactValue = {
    kind: "stated";
    value: number | string;
} | {
    kind: "bracket";
    at_least?: number;
    below?: number;
} | {
    kind: "unknown";
    why: WindowOverlayUnknownWhy;
};
export interface WindowOverlayFact {
    value: WindowOverlayFactValue;
    grade: WindowOverlayGrade;
    units: WindowOverlayUnits;
    boundary: WindowOverlayBoundary;
    source_ref: string;
    observed_at: string;
    [unknownField: string]: unknown;
}
export interface WindowOverlayCell {
    provider_id: string;
    model_id: string;
    /** Unknown fact keys are retained so a newer producer can coexist with this v1 consumer. */
    facts: Record<string, WindowOverlayFact>;
}
export interface WindowOverlay {
    schema: typeof WINDOW_OVERLAY_SCHEMA;
    generated_at: string;
    minted_provider_ids: string[];
    cells: WindowOverlayCell[];
}
export interface ResolvedWindowOverlayFacts {
    /** Includes facts whose tagged value is explicitly unknown. */
    facts: Record<string, WindowOverlayFact>;
}
export interface WindowDerivation {
    window: number;
    reserve: number;
    reserveSource: WindowReserveSource;
    geometry: WindowGeometry;
}
export interface WindowGeometryResult {
    usableSoft: number;
    usableHard: number;
    geometry: WindowGeometry;
    derivation: WindowDerivation;
}
export interface DeriveWindowGeometryOptions {
    overlay?: ResolvedWindowOverlayFacts;
    /** A provider/auth hook has higher precedence than the overlay, field by field. */
    providerLimit?: ModelLimit;
    /** Resolved user override; higher precedence than catalog, overlay, and geometry defaults. */
    outputReserveOverride?: number;
    harness?: "opencode" | "pi";
    /** Detected overflow remains the final downward cap regardless of other sources. */
    contextCap?: number;
    log?: (message: string) => void;
}
/** Convert the ratified tagged numeric union into the conservative scalar used by derivation. */
export declare function scalarizeFact(value: WindowOverlayFactValue): number | undefined;
export declare function parseWindowOverlay(value: unknown): {
    overlay?: WindowOverlay;
    badCells: number;
    refusal?: string;
};
export declare function defaultWindowOverlayPath(): string;
export declare function readWindowOverlayFile(path: string, log?: (message: string) => void): WindowOverlay | undefined;
/** Set the user-tier overlay path. Undefined restores the Fusiform data-dir default. */
export declare function setWindowOverlayPath(path: string | undefined): void;
export declare function clearWindowOverlayCacheForTest(): void;
export declare function getWindowOverlay(): WindowOverlay | undefined;
export declare function resolveWindowOverlayFacts(providerID: string, modelID: string, overlay?: WindowOverlay | undefined): ResolvedWindowOverlayFacts | undefined;
/** Placeholder filtering is deliberately per output field, never a row-level rejection. */
export declare function placeholderFilteredOutput(output: number | undefined, context: number | undefined): number | undefined;
export declare function deriveWindowGeometry(providerID: string, modelID: string, catalogLimit: ModelLimit | undefined, options?: DeriveWindowGeometryOptions): WindowGeometryResult | undefined;
export declare function formatWindowDerivationLine(inputTokens: number, result: WindowGeometryResult): string;
export declare function formatCompactTokens(value: number): string;
//# sourceMappingURL=window-geometry.d.ts.map