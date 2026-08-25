#!/usr/bin/env bun

/**
 * Child bootstrap for one isolated incident case. Writes exactly one
 * schema-versioned envelope on the fd-3 result channel; stdout/stderr carry
 * diagnostics only.
 */

import { readFileSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import {
    parseIncidentCatalog,
    type IncidentVariant,
} from "../src/incident-pool/contract";
import { rowDigest, splitLedgerLines } from "../src/incident-pool/history";
import {
    builtinIncidentCaseRegistry,
    implementationBundleDigest,
    ledgerFingerprint,
    semanticFingerprint,
} from "../src/incident-pool/registry";
import {
    CASE_ENVELOPE_SCHEMA,
    type CaseEnvelope,
} from "../src/incident-pool/runner";

const E2E_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(E2E_ROOT, "../..");
const INCIDENTS_DIR = resolve(E2E_ROOT, "incidents");

function requireEnv(name: string): string {
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`missing required case environment variable ${name}`);
    }
    return value;
}

function findVariant(variantId: string): IncidentVariant {
    const catalogText = readFileSync(
        resolve(INCIDENTS_DIR, "catalog.json"),
        "utf8",
    );
    let rawCatalog: unknown;
    try {
        rawCatalog = JSON.parse(catalogText) as unknown;
    } catch (error) {
        throw new Error(
            `committed catalog.json is not valid JSON: ${String(error)}`,
        );
    }
    const catalog = parseIncidentCatalog(rawCatalog);
    for (const family of catalog.families) {
        for (const variant of family.variants) {
            if (variant.id === variantId) return variant;
        }
    }
    throw new Error(`variant ${variantId} is not in the committed catalog`);
}

async function main(): Promise<void> {
    const variantId = requireEnv("MC_INCIDENT_VARIANT_ID");
    const registry = builtinIncidentCaseRegistry();
    const registered = registry.get(variantId);
    if (!registered) {
        throw new Error(
            `variant ${variantId} has no registered case; scenario units register cases in builtinIncidentCaseRegistry`,
        );
    }
    const variant = findVariant(variantId);
    const adjudicationLines = splitLedgerLines(
        readFileSync(resolve(INCIDENTS_DIR, "adjudications.jsonl"), "utf8"),
    );

    const raw = await registered.driver({
        workspaceRoot: requireEnv("MC_INCIDENT_WORKSPACE_ROOT"),
        storeDir: requireEnv("MC_INCIDENT_STORE_DIR"),
        storeNamespace: requireEnv("MC_INCIDENT_STORE_NAMESPACE"),
    });
    const observation = registered.normalizer(raw);
    const precondition = registered.precondition(observation);

    const envelope: CaseEnvelope = {
        schema: CASE_ENVELOPE_SCHEMA,
        run_nonce: requireEnv("MC_INCIDENT_RUN_NONCE"),
        variant_id: variantId,
        semantic_fingerprint: semanticFingerprint(variant, registered.fixtures),
        implementation_digest: implementationBundleDigest(
            REPO_ROOT,
            registered.implementationFiles,
        ),
        ledger_fingerprint: ledgerFingerprint(adjudicationLines),
        baseline_event_id: requireEnv("MC_INCIDENT_BASELINE_EVENT_ID"),
        preconditions: "satisfied",
        precondition_reason: null,
        blocked_by: [],
        verdict: null,
        failed_checks: [],
        observation_signature: null,
    };

    if (precondition.satisfied) {
        const checks = registered.verifier(observation);
        const failed = checks
            .filter((check) => !check.passed)
            .map((check) => check.id);
        envelope.verdict = failed.length === 0 ? "pass" : "assertion_fail";
        envelope.failed_checks = failed;
        envelope.observation_signature =
            failed.length === 0 ? null : rowDigest(observation);
    } else {
        // A failed reproduction precondition must never reach the verifier.
        envelope.precondition_reason = precondition.reason;
        envelope.preconditions = "failed";
        envelope.blocked_by =
            precondition.reason === "blocked_by_dependency"
                ? precondition.blockedBy
                : [];
    }

    writeSync(3, `${JSON.stringify(envelope)}\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
        // Diagnostics only — the parent classifies a missing envelope as crash.
        console.error(
            `incident case failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    });
