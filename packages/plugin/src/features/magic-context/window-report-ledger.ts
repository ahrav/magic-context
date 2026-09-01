import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";
import { getMagicContextStorageDir } from "../../shared/data-path";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log } from "../../shared/logger";
import { getOrCreateSessionMeta } from "./storage-meta-session";

const WINDOW_REPORTS_FILE = "window-reports.jsonl";
const ROTATED_WINDOW_REPORTS_FILE = `${WINDOW_REPORTS_FILE}.1`;
export const WINDOW_REPORTS_ROTATION_BYTES = 16 * 1024 * 1024;

/**
 * `FORWARDING_PROVIDER_IDS` is an admit list, not a classification.
 * `FORWARDING_PROVIDER_IDS` membership permits only `path_may_forward: true`.
 * Omitting `path_may_forward` leaves routing unknown and refuses promotion.
 * `false` would permit promotion, but `FORWARDING_PROVIDER_IDS` cannot establish that a path does not forward.
 * cannot support.
 *
 */
export const FORWARDING_PROVIDER_IDS: ReadonlySet<string> = new Set([
    "302ai",
    "abacus",
    "ai-router",
    "aiand",
    "aihubmix",
    "alibaba-cn",
    "alibaba-coding-plan",
    "alibaba-coding-plan-cn",
    "alibaba-token-plan",
    "alibaba-token-plan-cn",
    "ambient",
    "anyapi",
    "auriko",
    "azure",
    "azure-cognitive-services",
    "baseten",
    "berget",
    "blueclaw",
    "chutes",
    "clarifai",
    "cline-pass",
    "cloudferro-sherlock",
    "cloudflare-ai-gateway",
    "cloudflare-workers-ai",
    "coralbricks",
    "cortecs",
    "crof",
    "crossmodel",
    "daoxe",
    "deepinfra",
    "digitalocean",
    "dinference",
    "drun",
    "empiriolabs",
    "evroc",
    "fastrouter",
    "fireworks-ai",
    "freemodel",
    "friendli",
    "frogbot",
    "github-copilot",
    "gmicloud",
    "google-vertex",
    "greenpt",
    "groq",
    "helicone",
    "hetzner",
    "hpc-ai",
    "huggingface",
    "hyper",
    "iflowcn",
    "impossibl",
    "inceptron",
    "inference",
    "inferx",
    "infomaniak",
    "io-net",
    "jiekou",
    "kenari",
    "kilo",
    "lilac",
    "llmgateway",
    "lmstudio",
    "meganova",
    "merge-gateway",
    "mixlayer",
    "modal",
    "model-oracle-ai",
    "modelis",
    "modelscope",
    "moonshotai-cn",
    "nano-gpt",
    "nearai",
    "nebius",
    "neon",
    "neuralwatt",
    "novita-ai",
    "nvidia",
    "ofox",
    "opencode",
    "opencode-go",
    "openrouter",
    "orcarouter",
    "ovhcloud",
    "perplexity-agent",
    "pioneer",
    "poe",
    "poolside",
    "privatemode-ai",
    "qihang-ai",
    "qiniu-ai",
    "qvac",
    "regolo-ai",
    "requesty",
    "routing-run",
    "salad-cloud",
    "sap-ai-core",
    "scaleway",
    "siliconflow",
    "siliconflow-cn",
    "snowflake-cortex",
    "stackit",
    "subconscious",
    "submodel",
    "synthetic",
    "tencent-coding-plan",
    "tensorx",
    "thinkingmachines",
    "tinfoil",
    "togetherai",
    "unorouter",
    "venice",
    "vercel",
    "vivgrid",
    "vultr",
    "wandb",
    "watsonx",
    "xpersona",
    "zai",
    "zai-coding-plan",
    "zenifra",
    "zenmux",
    "zhipuai",
    "zhipuai-coding-plan",
]);

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
     * Omitting `path_may_forward` leaves routing unknown and refuses promotion.
     * This reporter never emits `false` because it cannot establish that a path does not forward.
     */
    path_may_forward?: true;
    /** `served_by_hint` uses only observed evidence, never provider configuration. */
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

let swallowedWriteCount = 0;
let lastErrorMessage: string | null = null;

export function getWindowReportsPath(): string {
    return path.join(getMagicContextStorageDir(), WINDOW_REPORTS_FILE);
}

function recordSwallowedWrite(error: unknown): void {
    try {
        swallowedWriteCount++;
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        log("[magic-context] window report ledger write failed:", error);
    } catch {
        // The ledger must not throw even if logging diagnostics cannot be recorded.
    }
}

export function getWindowReportLedgerDiagnostics(): WindowReportLedgerDiagnostics {
    return { swallowedWriteCount, lastErrorMessage };
}

export function __resetWindowReportLedgerDiagnosticsForTests(): void {
    swallowedWriteCount = 0;
    lastErrorMessage = null;
}

function positiveFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function observedStatus(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as Record<string, unknown>;
    for (const value of [candidate.status, candidate.statusCode]) {
        if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
            return value;
        }
    }
    const nested = candidate.response;
    if (nested && typeof nested === "object") {
        return observedStatus(nested);
    }
    return undefined;
}

function observedHeaderHint(headers: unknown): string | undefined {
    if (!headers || typeof headers !== "object") return undefined;
    const values = headers as Record<string, unknown>;
    for (const key of ["x-served-by", "x-upstream", "x-backend"]) {
        const fromGet = typeof values.get === "function" ? values.get(key) : undefined;
        const value = fromGet ?? values[key] ?? values[key.toUpperCase()];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

function observedErrorBodyHint(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const message = (error as Record<string, unknown>).message;
    const body = typeof message === "string" ? message : undefined;
    const match = body?.match(/(?:served by|upstream|backend)\s*[:=]?\s*([a-z0-9._-]+)/i);
    return match?.[1];
}

function observedErrorHint(error: unknown): string | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as Record<string, unknown>;
    const direct =
        candidate.served_by ?? candidate.servedBy ?? candidate.upstream ?? candidate.backend;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const headerHint = observedHeaderHint(candidate.headers);
    if (headerHint) return headerHint;
    const bodyHint = observedErrorBodyHint(error);
    if (bodyHint) return bodyHint;
    const response = candidate.response;
    if (response && typeof response === "object") return observedErrorHint(response);
    return undefined;
}

function observedModelVendorHint(modelID: string | undefined): string | undefined {
    if (!modelID) return undefined;
    const slash = modelID.indexOf("/");
    return slash > 0 ? modelID.slice(0, slash) : undefined;
}

function readLargestSuccess(
    db: import("../../shared/sqlite").Database,
    sessionId: string | undefined,
    providerID: string | undefined,
    modelID: string | undefined,
): number | undefined {
    if (!sessionId || !providerID || !modelID) return undefined;
    const meta = getOrCreateSessionMeta(db, sessionId);
    return piModelRefToCanonical(meta.lastObservedModelKey ?? "") ===
        piModelRefToCanonical(`${providerID}/${modelID}`)
        ? positiveFiniteNumber(meta.observedSafeInputTokens)
        : undefined;
}

export function buildWindowReport(input: AppendWindowReportInput): WindowReport {
    const report: WindowReport = {
        access_path: "api",
        geometry: input.reportedLimitProvenance ?? "unknown",
        observed_at_ms: input.observedAtMs ?? Date.now(),
        ...(input.providerID && FORWARDING_PROVIDER_IDS.has(input.providerID)
            ? { path_may_forward: true as const }
            : {}),
    };
    if (input.providerID) report.provider_id = input.providerID;
    if (input.modelID) report.model_id = input.modelID;
    if (input.matchedPattern) report.matched_pattern = input.matchedPattern;
    const limit = positiveFiniteNumber(input.reportedLimit);
    if (limit) {
        report.extracted_limit = limit;
        report.extracted_limit_units = "provider";
    }
    const attempted = positiveFiniteNumber(input.attemptedTokens);
    if (attempted) {
        report.attempted_tokens = attempted;
        report.attempted_tokens_units = "estimate";
    }
    const status = observedStatus(input.error);
    if (status) report.status = status;
    const largestSuccess = readLargestSuccess(
        input.db,
        input.sessionID,
        input.providerID,
        input.modelID,
    );
    if (largestSuccess) {
        report.largest_success = largestSuccess;
        report.largest_success_units = "estimate";
    }
    const servedByHint = observedErrorHint(input.error) ?? observedModelVendorHint(input.modelID);
    if (servedByHint) report.served_by_hint = servedByHint;
    return report;
}

export function appendWindowReport(report: WindowReport): void {
    try {
        const reportPath = getWindowReportsPath();
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        if (
            fs.existsSync(reportPath) &&
            fs.statSync(reportPath).size > WINDOW_REPORTS_ROTATION_BYTES
        ) {
            const rotatedPath = path.join(path.dirname(reportPath), ROTATED_WINDOW_REPORTS_FILE);
            fs.rmSync(rotatedPath, { force: true });
            fs.renameSync(reportPath, rotatedPath);
        }
        fs.appendFileSync(reportPath, `${JSON.stringify(report)}\n`);
    } catch (error) {
        recordSwallowedWrite(error);
    }
}

export function captureWindowReport(input: AppendWindowReportInput): void {
    try {
        appendWindowReport(buildWindowReport(input));
    } catch (error) {
        recordSwallowedWrite(error);
    }
}
