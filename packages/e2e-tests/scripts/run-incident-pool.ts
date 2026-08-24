#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HARNESSES, LANES, type Harness, type Lane } from "../src/incident-pool/contract";
import { validateIncidentHistory } from "../src/incident-pool/history";
import {
    builtinIncidentCaseRegistry,
    implementationBundleDigest,
    validateRegistryCatalogCorrespondence,
} from "../src/incident-pool/registry";
import {
    incidentPoolExitCode,
    publishIncidentReport,
    unexpectedIncompleteResults,
} from "../src/incident-pool/report";
import {
    DEFAULT_CASE_TIMEOUT_MS,
    buildRunSnapshot,
    runCaseInIsolation,
    runIncidentPool,
    unavailableCaseResult,
} from "../src/incident-pool/runner";
import { E2E_ROOT, INCIDENTS_DIR, loadHistorySnapshot } from "./validate-incident-history";

const REPO_ROOT = resolve(E2E_ROOT, "../..");

interface CliArgs {
    harness: Harness;
    lanes: Lane[];
    reportPath: string;
    timeoutMs: number;
}

function parseArgs(args: string[]): CliArgs {
    let harness: Harness = "opencode";
    let lanes: Lane[] = ["green", "known-red"];
    let reportPath = resolve(E2E_ROOT, "incident-report.json");
    let timeoutMs = DEFAULT_CASE_TIMEOUT_MS;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--harness") {
            const value = args[++index];
            if (!value || !HARNESSES.includes(value as Harness)) {
                throw new Error(`--harness requires one of ${HARNESSES.join(", ")}`);
            }
            harness = value as Harness;
        } else if (arg === "--lane") {
            const value = args[++index];
            if (value === "all") {
                lanes = ["green", "known-red"];
            } else if (value && LANES.includes(value as Lane) && value !== "adjudication-only") {
                lanes = [value as Lane];
            } else {
                throw new Error("--lane requires green, known-red, or all");
            }
        } else if (arg === "--report") {
            const value = args[++index];
            if (!value) throw new Error("--report requires a file path");
            reportPath = resolve(value);
        } else if (arg === "--timeout") {
            const value = Number(args[++index]);
            if (!Number.isInteger(value) || value <= 0) throw new Error("--timeout requires positive milliseconds");
            timeoutMs = value;
        } else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-incident-pool.ts [--harness opencode|pi|rust] [--lane green|known-red|all] [--report <path>] [--timeout <ms>]",
            );
            process.exit(0);
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    return { harness, lanes, reportPath, timeoutMs };
}

async function main(): Promise<number> {
    const { harness, lanes, reportPath, timeoutMs } = parseArgs(Bun.argv.slice(2));
    const files = loadHistorySnapshot(INCIDENTS_DIR, "working");
    const state = validateIncidentHistory(files);
    const registry = builtinIncidentCaseRegistry();
    validateRegistryCatalogCorrespondence(registry, state.catalog);

    const implementationDigests = new Map<string, string>();
    for (const [variantId, registered] of registry) {
        implementationDigests.set(variantId, implementationBundleDigest(REPO_ROOT, registered.implementationFiles));
    }

    const snapshot = buildRunSnapshot({
        catalog: state.catalog,
        ledger: state.ledger,
        adjudicationLines: files.adjudicationLines,
        harness,
        lanes,
        implementationDigests,
    });
    for (const excluded of snapshot.excluded) {
        console.error(`[incident-pool] not scheduled ${excluded.variantId}: ${excluded.reason}`);
    }

    const workspaceParentDir = mkdtempSync(join(tmpdir(), "incident-pool-"));
    const childScript = resolve(import.meta.dir, "run-incident-case.ts");
    try {
        const report = await runIncidentPool(snapshot, async (selected) => {
            const registered = registry.get(selected.variantId);
            const prerequisite = registered?.prerequisite?.() ?? { ok: true as const };
            if (!prerequisite.ok) {
                console.error(`[incident-pool] ${selected.variantId} unavailable: ${prerequisite.reason}`);
                return unavailableCaseResult(selected);
            }
            const execution = await runCaseInIsolation(snapshot, selected, {
                argv: [process.execPath, childScript],
                timeoutMs,
                workspaceParentDir,
            });
            console.error(
                `[incident-pool] ${selected.variantId}: ${execution.result.run_health} / ` +
                    `${execution.result.behavioral_verdict} / ${execution.result.baseline_comparison}`,
            );
            return execution.result;
        });
        publishIncidentReport(report, reportPath);
        console.log(
            `published ${reportPath}: ${report.variant_count} variants in ${report.family_count} families, ` +
                `evaluation_complete=${report.evaluation_complete}`,
        );
        for (const incomplete of unexpectedIncompleteResults(report)) {
            console.error(
                `[incident-pool] unexpected incomplete result ${incomplete.variant_id}: ` +
                    `${incomplete.run_health} (${incomplete.reason_code ?? "no reason"})`,
            );
        }
        return incidentPoolExitCode(report);
    } finally {
        rmSync(workspaceParentDir, { recursive: true, force: true });
    }
}

main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
        console.error(`incident pool run failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
