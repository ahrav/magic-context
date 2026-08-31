import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import manifestJson from "../../pools/paired-delta-manifest.json";
import {
    PAIRED_DELTA_MANIFEST_SCHEMA,
    parsePairedDeltaManifest,
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

/** The manifest is the sole source of run-mode membership. */
const runModesByScenarioId = new Map(
    parsePairedDeltaManifest(manifestJson).scenarios.map(
        ({ scenarioId, runModes }) => [scenarioId, runModes],
    ),
);

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
            runModes: runModesByScenarioId.get(declaration.scenarioId) ?? ["release"],
        },
    ]));
}

function semanticInput(declaration: ScenarioDeclaration): unknown {
    const { verifier: _verifier, ...serializable } = declaration;
    return { contract: "paired-delta-scenario/v1", ...serializable };
}

/** Covers the lane's own declaration and scoring code, not just the verifier bodies: `semanticInput` drops the verifier function and this digest previously hashed only the scenario files, so loosening `validateCheckVector` or `parseArmedCellResult` changed what every frozen scenario can score as passing while both fingerprints stayed identical. Hashing stops at the lane boundary — shared primitives reached by import are not covered. commentlint: allow(JUDGE) */
function verifierBundleDigest(root: string, implementationFile: string): string {
    const hash = createHash("sha256");
    for (const path of [
        "src/paired-delta/contract.ts",
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
            throw new Error(
                `paired-delta frozen scenario drift: ${actual.scenarioId}; ` +
                    "after an intentional change, regenerate with " +
                    "`bun run --cwd packages/e2e-tests freeze:paired-delta`",
            );
        }
    }
}

export function currentManifest(): PairedDeltaManifest {
    return {
        schema: PAIRED_DELTA_MANIFEST_SCHEMA,
        scenarios: computeManifestEntries(buildPairedDeltaRegistry()),
    };
}
