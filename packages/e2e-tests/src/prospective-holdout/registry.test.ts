import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { implementationBundleDigest } from "../incident-pool/registry";
import { registerProspectiveScenario, validateProspectiveRegistry, type ProspectiveRegistry, type ProspectiveScenario } from "./registry";
import { closeManifest, H2 } from "./test-fixtures";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FILE = "packages/e2e-tests/src/prospective-holdout/registry.test.ts";

function scenario(): ProspectiveScenario {
    return {
        caseId: `case-${"a".repeat(32)}`,
        familyId: "fam-context-loss",
        semanticRevision: "rev-first",
        scenarioFingerprint: H2,
        implementationFingerprint: implementationBundleDigest(REPO_ROOT, [FILE]),
        implementationFiles: [FILE],
        harness: "opencode",
        subjective: false,
        async driver() { return { state: "current" }; },
        async cleanup() {},
        normalizer(raw) { return raw; },
        verifier() { return [{ id: "check-current", passed: true }]; },
    };
}

describe("prospective scenario registry", () => {
    it("binds every admitted case to one live implementation bundle", () => {
        const registry: ProspectiveRegistry = new Map();
        registerProspectiveScenario(registry, scenario());
        expect(() => validateProspectiveRegistry(closeManifest(), registry, REPO_ROOT)).not.toThrow();
    });

    it("rejects extra, duplicate, stale, or declared-only cases", () => {
        const registry: ProspectiveRegistry = new Map();
        const entry = scenario();
        registerProspectiveScenario(registry, entry);
        expect(() => registerProspectiveScenario(registry, entry)).toThrow(/duplicate-case/);
        entry.implementationFingerprint = "f".repeat(64);
        expect(() => validateProspectiveRegistry(closeManifest(), registry, REPO_ROOT)).toThrow(/implementation-drift/);
        expect(() => validateProspectiveRegistry(closeManifest(), new Map(), REPO_ROOT)).toThrow(/cardinality-mismatch/);
    });

    it("separates an implementation path that escapes the root from one merely absent", () => {
        const escaping: ProspectiveRegistry = new Map();
        const outside = scenario();
        outside.implementationFiles = ["../../../../etc/passwd"];
        registerProspectiveScenario(escaping, outside);
        expect(() => validateProspectiveRegistry(closeManifest(), escaping, REPO_ROOT)).toThrow(
            /implementation-escapes-root/,
        );

        const absoluteRegistry: ProspectiveRegistry = new Map();
        const absolute = scenario();
        absolute.implementationFiles = ["/etc/passwd"];
        registerProspectiveScenario(absoluteRegistry, absolute);
        expect(() => validateProspectiveRegistry(closeManifest(), absoluteRegistry, REPO_ROOT)).toThrow(
            /implementation-escapes-root/,
        );

        // A path inside REPO_ROOT but absent from the tree throws implementation-unavailable rather than implementation-escapes-root.
        const missingRegistry: ProspectiveRegistry = new Map();
        const missing = scenario();
        missing.implementationFiles = ["packages/e2e-tests/src/prospective-holdout/absent-file.ts"];
        registerProspectiveScenario(missingRegistry, missing);
        expect(() => validateProspectiveRegistry(closeManifest(), missingRegistry, REPO_ROOT)).toThrow(
            /implementation-unavailable/,
        );
    });
});
