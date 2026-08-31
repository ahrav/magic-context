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

/** Every file a validation rule reads a value from, wherever it lives: `semanticInput` drops the verifier function, so without these a change to a parsing primitive, to `CHARS_PER_TOKEN`, to the search-token bound, or to the claim normalizer would alter what each frozen scenario accepts while both fingerprints stayed identical. Deliberately coarse — a whole file, not the one value consumed from it — because over-triggering a refreeze costs one command while under-triggering hides a semantic change. A direct-read list, not a transitive import closure: resolving the closure would make the digest depend on most of the repository and refreeze the pool on unrelated edits. commentlint: allow(JUDGE) */
const SHARED_VALIDATION_FILES = [
    "src/contract-primitives.ts",
    "src/ballast.ts",
    "src/paired-delta/contract.ts",
    "src/paired-delta/scenarios/support.ts",
    "../plugin/src/features/magic-context/search-bounds.ts",
    "../plugin/src/features/magic-context/memory/normalize-hash.ts",
] as const;

/** Read once per root rather than once per scenario: the shared files are identical for every entry, so re-reading them per scenario is pure I/O that grows with the pool. commentlint: allow(JUDGE) */
function sharedValidationBytes(root: string): ReadonlyArray<readonly [string, Buffer]> {
    const cached = sharedBytesByRoot.get(root);
    if (cached !== undefined) return cached;
    const bytes = SHARED_VALIDATION_FILES.map((path) =>
        [path, readFileSync(resolve(root, path))] as const);
    sharedBytesByRoot.set(root, bytes);
    return bytes;
}
const sharedBytesByRoot = new Map<string, ReadonlyArray<readonly [string, Buffer]>>();

function verifierBundleDigest(root: string, implementationFile: string): string {
    const hash = createHash("sha256");
    for (const [path, bytes] of sharedValidationBytes(root)) {
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
