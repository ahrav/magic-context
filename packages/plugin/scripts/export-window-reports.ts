#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import packageJson from "../package.json";
import { getWindowReportsPath, type WindowReport } from "../src/features/magic-context/window-report-ledger";

type FusiformWindowReport = {
    provider_id?: string;
    model_id?: string;
    access_path: "api";
    status?: number;
    matched_pattern?: string;
    extracted_limit?: number;
    attempted_tokens?: number;
    geometry: "prompt_only" | "combined" | "unknown";
    observed_at_ms: number;
    reporter: string;
    largest_success?: number;
    extracted_limit_units?: "provider";
    attempted_tokens_units?: "estimate";
    largest_success_units?: "estimate";
    /**
     */
    path_may_forward?: true;
    served_by_hint?: string;
};

export interface FusiformWindowReportExport {
    schema: "fusiform-window-report/v1";
    reports: FusiformWindowReport[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function geometry(value: unknown): FusiformWindowReport["geometry"] {
    return value === "prompt_only" || value === "combined" ? value : "unknown";
}

export function parseWindowReportJsonl(contents: string): WindowReport[] {
    const reports: WindowReport[] = [];
    for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!isRecord(parsed)) continue;
            const observedAt = optionalNumber(parsed.observed_at_ms);
            if (!observedAt) continue;
            reports.push({
                provider_id: optionalString(parsed.provider_id),
                model_id: optionalString(parsed.model_id),
                access_path: "api",
                status: optionalNumber(parsed.status),
                matched_pattern: optionalString(parsed.matched_pattern),
                extracted_limit: optionalNumber(parsed.extracted_limit),
                extracted_limit_units:
                    parsed.extracted_limit_units === "provider" ? "provider" : undefined,
                attempted_tokens: optionalNumber(parsed.attempted_tokens),
                attempted_tokens_units:
                    parsed.attempted_tokens_units === "estimate" ? "estimate" : undefined,
                geometry: geometry(parsed.geometry),
                observed_at_ms: observedAt,
                largest_success: optionalNumber(parsed.largest_success),
                largest_success_units:
                    parsed.largest_success_units === "estimate" ? "estimate" : undefined,
                path_may_forward: parsed.path_may_forward === true ? true : undefined,
                served_by_hint: optionalString(parsed.served_by_hint),
            });
        } catch {
            // A truncated trailing line must not prevent export of prior captures.
        }
    }
    return reports;
}

export function toFusiformWindowReport(report: WindowReport): FusiformWindowReport {
    const exported: FusiformWindowReport = {
        access_path: report.access_path,
        geometry: report.geometry,
        observed_at_ms: report.observed_at_ms,
        reporter: `magic-context@${packageJson.version}`,
    };
    for (const field of [
        "provider_id",
        "model_id",
        "status",
        "matched_pattern",
        "extracted_limit",
        "attempted_tokens",
        "largest_success",
        "extracted_limit_units",
        "attempted_tokens_units",
        "largest_success_units",
        "served_by_hint",
    ] as const) {
        const value = report[field];
        if (value !== undefined) exported[field] = value as never;
    }
    if (report.path_may_forward === true) exported.path_may_forward = true;
    return exported;
}

export function exportWindowReports(contents: readonly string[]): FusiformWindowReportExport {
    return {
        schema: "fusiform-window-report/v1",
        reports: contents.flatMap(parseWindowReportJsonl).map(toFusiformWindowReport),
    };
}

function outputPathFromArgs(args: readonly string[]): string | undefined {
    const index = args.indexOf("--out");
    if (index < 0) return undefined;
    const output = args[index + 1];
    if (!output) throw new Error("--out requires a file path");
    return output;
}

export function main(args = process.argv.slice(2)): void {
    const reportPath = getWindowReportsPath();
    const contents = [
        `${reportPath}.1`,
        reportPath,
    ].flatMap((filePath) => (existsSync(filePath) ? [readFileSync(filePath, "utf8")] : []));
    const output = `${JSON.stringify(exportWindowReports(contents), null, 2)}\n`;
    const outPath = outputPathFromArgs(args);
    if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, output);
    } else {
        process.stdout.write(output);
    }
}

if (import.meta.main) main();
