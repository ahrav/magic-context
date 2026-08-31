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

/** Lane-owned files only, and that boundary is a correctness requirement rather than a tradeoff. A digest input must change only when the pool's own meaning changes; hashing a file the pool does not own breaks that, because `pull_request` CI evaluates the merge commit, so any upstream edit to a shared file makes every entry drift on a branch that touched no scenario — and it fails in CI while passing locally, which is the least debuggable shape available. Shared primitives are guarded by their own tests and by every lane that uses them, not by this fingerprint. Deliberately coarse within the boundary: over-triggering a refreeze costs one command, under-triggering hides a semantic change. commentlint: allow(JUDGE) */
const LANE_VALIDATION_FILES = [
    "src/paired-delta/contract.ts",
    "src/paired-delta/scenarios/support.ts",
] as const;

/** Read once per root rather than once per scenario: these files are identical for every entry, so re-reading them per scenario is pure I/O that grows with the pool. commentlint: allow(JUDGE) */
const laneBytesByRoot = new Map<string, ReadonlyArray<readonly [string, Buffer]>>();

function laneValidationBytes(root: string): ReadonlyArray<readonly [string, Buffer]> {
    const cached = laneBytesByRoot.get(root);
    if (cached !== undefined) return cached;
    const bytes = LANE_VALIDATION_FILES.map((path) =>
        [path, readFileSync(resolve(root, path))] as const);
    laneBytesByRoot.set(root, bytes);
    return bytes;
}

function verifierBundleDigest(root: string, implementationFile: string): string {
    const hash = createHash("sha256");
    for (const [path, bytes] of laneValidationBytes(root)) {
        hash.update(path);
        hash.update("\0");
        hash.update(bytes);
    }
    hash.update(implementationFile);
    hash.update("\0");
    hash.update(readFileSync(resolve(root, implementationFile)));
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
