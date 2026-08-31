import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

// REPORTER derives its version from package.json so version bumps do not require test updates.
const REPORTER = `magic-context@${packageJson.version}`;

describe("export-window-reports", () => {
    it("exports strict fusiform reports with the pinned units and routing field spelling", () => {
        const dataHome = mkdtempSync(join(tmpdir(), "mc-window-report-export-"));
        const reportsDir = join(dataHome, "cortexkit", "magic-context");
        const outPath = join(dataHome, "out", "reports.json");
        try {
            mkdirSync(reportsDir, { recursive: true });
            writeFileSync(
                join(reportsDir, "window-reports.jsonl.1"),
                [
                    JSON.stringify({
                        access_path: "api",
                        matched_pattern: "prompt is too long",
                        attempted_tokens: 214_311,
                        attempted_tokens_units: "estimate",
                        geometry: "unknown",
                        observed_at_ms: 1,
                    }),
                    "",
                ].join("\n"),
            );
            writeFileSync(
                join(reportsDir, "window-reports.jsonl"),
                [
                    JSON.stringify({
                        provider_id: "anthropic",
                        model_id: "claude-sonnet-4-5",
                        access_path: "api",
                        status: 400,
                        matched_pattern: "anthropic_prompt_too_long",
                        extracted_limit: 200_000,
                        extracted_limit_units: "provider",
                        attempted_tokens: 214_311,
                        attempted_tokens_units: "estimate",
                        geometry: "prompt_only",
                        observed_at_ms: 2,
                        largest_success: 199_500,
                        largest_success_units: "estimate",
                    }),
                    JSON.stringify({
                        provider_id: "openrouter",
                        model_id: "anthropic/claude-sonnet-4-5",
                        access_path: "api",
                        status: 400,
                        matched_pattern: "maximum context length is \\d+ tokens",
                        extracted_limit: 200_000,
                        extracted_limit_units: "provider",
                        geometry: "combined",
                        observed_at_ms: 3,
                        path_may_forward: true,
                        served_by_hint: "anthropic",
                    }),
                    "",
                ].join("\n"),
            );

            const script = join(import.meta.dir, "export-window-reports.ts");
            execFileSync(process.execPath, [script, "--out", outPath], {
                env: { ...process.env, XDG_DATA_HOME: dataHome },
            });

            expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({
                schema: "fusiform-window-report/v1",
                reports: [
                    {
                        access_path: "api",
                        matched_pattern: "prompt is too long",
                        attempted_tokens: 214_311,
                        attempted_tokens_units: "estimate",
                        geometry: "unknown",
                        observed_at_ms: 1,
                        reporter: REPORTER,
                    },
                    {
                        provider_id: "anthropic",
                        model_id: "claude-sonnet-4-5",
                        access_path: "api",
                        status: 400,
                        matched_pattern: "anthropic_prompt_too_long",
                        extracted_limit: 200_000,
                        attempted_tokens: 214_311,
                        extracted_limit_units: "provider",
                        attempted_tokens_units: "estimate",
                        largest_success_units: "estimate",
                        geometry: "prompt_only",
                        observed_at_ms: 2,
                        reporter: REPORTER,
                        largest_success: 199_500,
                    },
                    {
                        provider_id: "openrouter",
                        model_id: "anthropic/claude-sonnet-4-5",
                        access_path: "api",
                        status: 400,
                        matched_pattern: "maximum context length is \\d+ tokens",
                        extracted_limit: 200_000,
                        extracted_limit_units: "provider",
                        geometry: "combined",
                        observed_at_ms: 3,
                        reporter: REPORTER,
                        path_may_forward: true,
                        served_by_hint: "anthropic",
                    },
                ],
            });
        } finally {
            rmSync(dataHome, { recursive: true, force: true });
        }
    });
});
