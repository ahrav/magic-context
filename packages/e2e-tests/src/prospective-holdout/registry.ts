import { resolve } from "node:path";
import { isWithin } from "../../../plugin/src/features/magic-context/memory/verification-paths";
import type { CohortCloseManifest } from "./contract";
import { HoldoutContractError } from "./contract";
import { implementationBundleDigest } from "../incident-pool/registry";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ProspectiveHarness = "opencode" | "pi" | "rust";

export interface ProspectiveCheck {
    id: string;
    passed: boolean;
}

export interface ProspectiveExecutionContext {
    workspaceRoot: string;
    releaseRoot: string;
    model: string;
    seed: number;
    platform: string;
    signal: AbortSignal;
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
    driver(context: ProspectiveExecutionContext): Promise<JsonValue>;
    cleanup(context: ProspectiveExecutionContext): Promise<void>;
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
    const root = resolve(repositoryRoot);
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
        // Reject paths outside `root` before the catch maps digest failures to `implementation-unavailable`.
        // Reject paths outside `root` before the catch maps digest failures to `implementation-unavailable`.
        // Reject paths outside `root` before the catch maps digest failures to `implementation-unavailable`.
        for (const file of scenario.implementationFiles) {
            if (!isWithin(root, resolve(root, file))) {
                throw new HoldoutContractError(["prospective-registry: implementation-escapes-root"]);
            }
        }
        let observed: string;
        try {
            observed = implementationBundleDigest(root, scenario.implementationFiles);
        } catch {
            throw new HoldoutContractError(["prospective-registry: implementation-unavailable"]);
        }
        if (observed !== scenario.implementationFingerprint) {
            throw new HoldoutContractError(["prospective-registry: implementation-drift"]);
        }
    }
}
