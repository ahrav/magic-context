import type { CohortCloseManifest } from "./contract";
import { HoldoutContractError } from "./contract";
import { implementationBundleDigest } from "../incident-pool/registry";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProspectiveHarness = "opencode" | "pi" | "rust";

export interface ProspectiveCheck {
    id: string;
    passed: boolean;
}

export interface ProspectiveScenario {
    caseId: string;
    familyId: string;
    semanticRevision: string;
    scenarioFingerprint: string;
    implementationFingerprint: string;
    implementationFiles: string[];
    harness: ProspectiveHarness;
    subjective: boolean;
    driver(context: { workspaceRoot: string; releaseRoot: string }): Promise<JsonValue>;
    normalizer(raw: JsonValue): JsonValue;
    verifier(observation: JsonValue): ProspectiveCheck[];
}

export type ProspectiveRegistry = Map<string, ProspectiveScenario>;

export function registerProspectiveScenario(registry: ProspectiveRegistry, scenario: ProspectiveScenario): void {
    if (!/^case-[0-9a-f]{32}$/.test(scenario.caseId)) {
        throw new HoldoutContractError(["prospective-registry: case-id-invalid"]);
    }
    if (registry.has(scenario.caseId)) {
        throw new HoldoutContractError(["prospective-registry: duplicate-case"]);
    }
    if (!/^rev-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.semanticRevision)) {
        throw new HoldoutContractError(["prospective-registry: revision-invalid"]);
    }
    if (scenario.implementationFiles.length === 0) {
        throw new HoldoutContractError(["prospective-registry: implementation-empty"]);
    }
    registry.set(scenario.caseId, scenario);
}

export function validateProspectiveRegistry(
    close: CohortCloseManifest,
    registry: ProspectiveRegistry,
    repositoryRoot: string,
): void {
    const admitted = new Map(close.body.cases.map((entry) => [entry.caseId, entry]));
    if (registry.size !== admitted.size) {
        throw new HoldoutContractError(["prospective-registry: cardinality-mismatch"]);
    }
    for (const [caseId, scenario] of registry) {
        const closed = admitted.get(caseId);
        if (!closed) throw new HoldoutContractError(["prospective-registry: unadmitted-case"]);
        if (
            scenario.familyId !== closed.familyId ||
            scenario.scenarioFingerprint !== closed.scenarioFingerprint ||
            scenario.subjective !== closed.subjective
        ) {
            throw new HoldoutContractError(["prospective-registry: close-binding-mismatch"]);
        }
        let observed: string;
        try {
            observed = implementationBundleDigest(repositoryRoot, scenario.implementationFiles);
        } catch {
            throw new HoldoutContractError(["prospective-registry: implementation-unavailable"]);
        }
        if (observed !== scenario.implementationFingerprint) {
            throw new HoldoutContractError(["prospective-registry: implementation-drift"]);
        }
    }
}
