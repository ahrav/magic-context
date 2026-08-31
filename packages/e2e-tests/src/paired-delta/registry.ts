import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    PAIRED_DELTA_MANIFEST_SCHEMA,
    type PairedDeltaManifest,
    type PairedDeltaManifestEntry,
    type RunMode,
    type ScenarioDeclaration,
} from "./contract";
import { pairedDeltaScenarios } from "./scenarios";

export interface RegisteredPairedDeltaScenario {
    declaration: ScenarioDeclaration;
    implementationFile: string;
    runModes: RunMode[];
}

export type PairedDeltaRegistry = Map<string, RegisteredPairedDeltaScenario>;

const CALIBRATION_IDS = new Set([
    "var-compaction-deploy-region",
    "var-compaction-schema-version",
    "var-exact-symbol",
    "var-superseded-timeout",
    "var-rejected-database",
]);

const fileByScenarioId = new Map(
    pairedDeltaScenarios.map(({ scenarioId }) => [
        scenarioId,
        `src/paired-delta/scenarios/${scenarioId.replace(/^var-/, "")}.ts`,
    ]),
);

export function buildPairedDeltaRegistry(): PairedDeltaRegistry {
    return new Map(pairedDeltaScenarios.map((declaration) => [
        declaration.scenarioId,
        {
            declaration,
            implementationFile: fileByScenarioId.get(declaration.scenarioId)!,
            runModes: CALIBRATION_IDS.has(declaration.scenarioId)
                ? ["calibration", "weekly", "release"]
                : ["release"],
        },
    ]));
}

function semanticInput(declaration: ScenarioDeclaration): unknown {
    const { verifier: _verifier, ...serializable } = declaration;
    return { contract: "paired-delta-scenario/v1", ...serializable };
}

function verifierBundleDigest(root: string, implementationFile: string): string {
    const hash = createHash("sha256");
    for (const path of [
        "src/paired-delta/scenarios/support.ts",
        implementationFile,
    ]) {
        const bytes = readFileSync(resolve(root, path));
        hash.update(path);
        hash.update("\0");
        hash.update(bytes);
    }
    return hash.digest("hex");
}

export function computeManifestEntries(
    registry: PairedDeltaRegistry,
    root = resolve(import.meta.dir, "../.."),
): PairedDeltaManifestEntry[] {
    return [...registry.values()]
        .map(({ declaration, implementationFile, runModes }) => ({
            scenarioId: declaration.scenarioId,
            semanticFingerprint: canonicalFingerprint(semanticInput(declaration)),
            verifierBundleDigest: verifierBundleDigest(root, implementationFile),
            runModes,
        }))
        .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

export function assertFrozenPool(
    registry: PairedDeltaRegistry,
    manifest: PairedDeltaManifest,
): void {
    const computed = computeManifestEntries(registry);
    if (
        computed.length !== manifest.scenarios.length ||
        computed.some(({ scenarioId }) =>
            !manifest.scenarios.some((entry) => entry.scenarioId === scenarioId))
    ) {
        throw new Error("paired-delta manifest correspondence mismatch");
    }
    const expected = new Map(manifest.scenarios.map((entry) => [entry.scenarioId, entry]));
    for (const actual of computed) {
        const frozen = expected.get(actual.scenarioId)!;
        if (
            actual.semanticFingerprint !== frozen.semanticFingerprint ||
            actual.verifierBundleDigest !== frozen.verifierBundleDigest
        ) {
            throw new Error(`paired-delta frozen scenario drift: ${actual.scenarioId}`);
        }
    }
}

export function currentManifest(): PairedDeltaManifest {
    return {
        schema: PAIRED_DELTA_MANIFEST_SCHEMA,
        scenarios: computeManifestEntries(buildPairedDeltaRegistry()),
    };
}
