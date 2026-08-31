import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Harness } from "../src/incident-pool/contract";
import { detectRustPrerequisites } from "../scripts/check-rust-prerequisites";
import { validateIncidentHistory } from "../src/incident-pool/history";
import {
    builtinIncidentCaseRegistry,
    implementationBundleDigest,
    validateRegistryCatalogCorrespondence,
} from "../src/incident-pool/registry";
import type { IncidentCaseResult } from "../src/incident-pool/report";
import {
    buildRunSnapshot,
    runCaseInIsolation,
    unavailableCaseResult,
} from "../src/incident-pool/runner";
import {
    E2E_ROOT,
    INCIDENTS_DIR,
    loadHistorySnapshot,
} from "../scripts/validate-incident-history";

// Keep the case timeout below bun:test's timeout so the runner classifies failures before bun:test terminates the child.
const GREEN_TEST_TIMEOUT_MS = 300_000;
const GREEN_CASE_TIMEOUT_MS = GREEN_TEST_TIMEOUT_MS - 60_000;

const OPENCODE_GREEN_VARIANT_IDS = [
    "var-a5-archived-reobservation",
    "var-a10-supersede-effective-context",
    "var-a28-historian-dump-containment",
    "var-a54-pending-note-recall",
    "var-thinking-nudge-anchor",
    "var-thinking-dropped-shell",
    "var-thinking-image-survival",
] as const;

const RUST_GREEN_VARIANT_IDS = [
    "var-parity-a1-pure-defer-stability",
    "var-parity-a3-ctx-reduce-survival",
] as const;

const mode = process.env.MC_E2E_MODE === "rust" ? "rust" : "ts";
const harness: Harness = mode === "rust" ? "rust" : "opencode";

if (mode === "rust" && !process.env.MC_E2E_DIRECT_HOST_FIXTURE_BIN) {
    const prereqs = detectRustPrerequisites({ allowBuild: true });
    if (prereqs.fixtureBin) {
        process.env.MC_E2E_DIRECT_HOST_FIXTURE_BIN = prereqs.fixtureBin;
    }
}
const variantIds =
    mode === "rust" ? RUST_GREEN_VARIANT_IDS : OPENCODE_GREEN_VARIANT_IDS;
const historyFiles = loadHistorySnapshot(INCIDENTS_DIR, "working");
const history = validateIncidentHistory(historyFiles);
const registry = builtinIncidentCaseRegistry();
validateRegistryCatalogCorrespondence(registry, history.catalog);
const implementationDigests = new Map(
    [...registry].map(([variantId, registered]) => [
        variantId,
        implementationBundleDigest(
            resolve(E2E_ROOT, "../.."),
            registered.implementationFiles,
        ),
    ]),
);
let workspaceParentDir: string;

beforeAll(() => {
    workspaceParentDir = mkdtempSync(join(tmpdir(), "incident-green-"));
});

afterAll(() => {
    rmSync(workspaceParentDir, { recursive: true, force: true });
});

async function runGreenVariant(variantId: string): Promise<IncidentCaseResult> {
    const snapshot = buildRunSnapshot({
        catalog: history.catalog,
        ledger: history.ledger,
        adjudicationLines: historyFiles.adjudicationLines,
        harness,
        lanes: ["green"],
        variantIds: [variantId],
        implementationDigests,
    });
    if (snapshot.selected.length !== 1) {
        throw new Error(
            `green wrapper ${variantId} selected ${snapshot.selected.length} cases`,
        );
    }
    const selected = snapshot.selected[0]!;
    const registered = registry.get(variantId);
    if (!registered) throw new Error(`green variant ${variantId} is not registered`);
    const prerequisite = registered.prerequisite?.() ?? { ok: true as const };
    if (!prerequisite.ok) return unavailableCaseResult(selected);
    const execution = await runCaseInIsolation(snapshot, selected, {
        argv: [
            process.execPath,
            resolve(E2E_ROOT, "scripts", "run-incident-case.ts"),
        ],
        timeoutMs: GREEN_CASE_TIMEOUT_MS,
        workspaceParentDir,
        extraEnv: { MC_E2E_MODE: mode },
    });
    return execution.result;
}

describe(`incident pool baseline-green wrappers (${harness})`, () => {
    for (const variantId of variantIds) {
        it(
            variantId,
            async () => {
                const result = await runGreenVariant(variantId);
                expect(result.variant_id).toBe(variantId);
                expect(result.run_health).toBe("completed");
                expect(result.behavioral_verdict).toBe("pass");
                expect(result.baseline_comparison).toBe("expected_green");
                expect(result.reason_code).toBeNull();
            },
            GREEN_TEST_TIMEOUT_MS,
        );
    }
});
