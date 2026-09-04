import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";
export declare const WINDOW_REPORTS_ROTATION_BYTES: number;
/**
 * Fusiform's full-catalog dual-detector admit sweep (pm_d3e23fcd, 2026-08-13:
 * 125 providers / 5,680 models whose catalogs carry other vendors' models).
 * An ADMIT list, not a classification — membership warrants
 * `path_may_forward: true` at capture; absence clears nobody (a provider
 * using an id convention neither detector knows is silently missing here),
 * which is why the emitter never writes `false`: the report schema pins
 * absent = unknown routing (refuses promotion, same as true), while an
 * explicit false would PERMIT promotion — a claim this set structurally
 * cannot support.
 *
 * `ollama-cloud` is deliberately EXCLUDED: the detectors admit it (it
 * carries glm/deepseek/kimi weights) but it imposes its OWN wall from its
 * own serving stack — and this field marks whose-wall-might-fire, not
 * who-carries-whose-models. Other own-wall gateways may hide in this list;
 * only per-cell evidence distinguishes them, and Fusiform's adjudicator
 * refuses promotion for every admitted provider regardless, so a wrong
 * `true` here degrades toward refusal, never toward a wrong mint.
 */
export declare const FORWARDING_PROVIDER_IDS: ReadonlySet<string>;
export interface WindowReport {
    provider_id?: string;
    model_id?: string;
    access_path: "api";
    status?: number;
    matched_pattern?: string;
    extracted_limit?: number;
    extracted_limit_units?: "provider";
    attempted_tokens?: number;
    attempted_tokens_units?: "estimate";
    geometry: "prompt_only" | "combined" | "unknown";
    observed_at_ms: number;
    largest_success?: number;
    largest_success_units?: "estimate";
    /**
     * Emitted ONLY as `true` (provider is a known forwarder) or omitted
     * (unknown routing — refuses promotion by the schema's absent rule).
     * Never `false`: this reporter has no evidence basis for asserting a
     * path cannot forward, and explicit false is the one value that would
     * permit promoting a measured report at a forwarded key.
     */
    path_may_forward?: true;
    /** Observed routing evidence only; never inferred from provider configuration. */
    served_by_hint?: string;
}
export interface AppendWindowReportInput {
    db: import("../../shared/sqlite").Database;
    providerID?: string;
    modelID?: string;
    matchedPattern?: string;
    reportedLimit?: number;
    reportedLimitProvenance?: ContextLimitProvenance;
    attemptedTokens?: number;
    error?: unknown;
    observedAtMs?: number;
    sessionID?: string;
}
export interface WindowReportLedgerDiagnostics {
    swallowedWriteCount: number;
    lastErrorMessage: string | null;
}
export declare function getWindowReportsPath(): string;
export declare function getWindowReportLedgerDiagnostics(): WindowReportLedgerDiagnostics;
export declare function __resetWindowReportLedgerDiagnosticsForTests(): void;
export declare function buildWindowReport(input: AppendWindowReportInput): WindowReport;
export declare function appendWindowReport(report: WindowReport): void;
export declare function captureWindowReport(input: AppendWindowReportInput): void;
//# sourceMappingURL=window-report-ledger.d.ts.map