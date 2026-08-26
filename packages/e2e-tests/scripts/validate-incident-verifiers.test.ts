import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseIncidentCatalog } from "../src/incident-pool/contract";
import { E2E_ROOT, boundVerifierFiles } from "../src/incident-pool/evidence";
import { builtinIncidentCaseRegistry } from "../src/incident-pool/registry";
import {
    assertBoundVerifierBytesUnchanged,
    assertCatalogBoundVerifierBytesUnchanged,
} from "./validate-incident-verifiers";

function committedCatalog() {
    return parseIncidentCatalog(
        JSON.parse(
            readFileSync(
                resolve(E2E_ROOT, "incidents", "catalog.json"),
                "utf8",
            ),
        ) as unknown,
    );
}

describe("incident verifier contributor gate", () => {
    it("accepts unchanged bound verifier bytes", () => {
        expect(() =>
            assertBoundVerifierBytesUnchanged(
                { "tests/verifier.test.ts": "a".repeat(64) },
                { "tests/verifier.test.ts": "a".repeat(64) },
            ),
        ).not.toThrow();
    });

    it("blocks changed, added, or removed bound verifiers without replay support", () => {
        for (const [accepted, current] of [
            [
                { "tests/verifier.test.ts": "a".repeat(64) },
                { "tests/verifier.test.ts": "b".repeat(64) },
            ],
            [{}, { "tests/verifier.test.ts": "b".repeat(64) }],
            [{ "tests/verifier.test.ts": "a".repeat(64) }, {}],
        ] as const) {
            expect(() =>
                assertBoundVerifierBytesUnchanged(accepted, current),
            ).toThrow(/changed without recorded mutation replay support/);
        }
    });
});

describe("catalog-bound executable verifier gate", () => {
    const scenario = "src/incident-pool/scenarios/audit-memory-search.ts";
    const key = `packages/e2e-tests/${scenario}`;

    it("covers every executable module the committed catalog binds", () => {
        // The mutation-command map names Rust degradation tests and standalone
        // Bun test files, never the modules that score the pool. Deriving the
        // set from the bindings is what puts the scoring verifiers under a gate.
        const files = boundVerifierFiles(committedCatalog());
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            expect(file.startsWith("src/incident-pool/scenarios/")).toBe(true);
        }
        // Every registered case's module is represented, so no scoring verifier
        // sits outside the compared set.
        expect(builtinIncidentCaseRegistry().size).toBe(21);
    });

    it("accepts unchanged bound module bytes", () => {
        expect(() =>
            assertCatalogBoundVerifierBytesUnchanged(
                { [key]: "a".repeat(64) },
                { [key]: "a".repeat(64) },
            ),
        ).not.toThrow();
    });

    it("blocks a changed bound module", () => {
        expect(() =>
            assertCatalogBoundVerifierBytesUnchanged(
                { [key]: "a".repeat(64) },
                { [key]: "b".repeat(64) },
            ),
        ).toThrow(/changed without recorded replay support/);
    });

    it("blocks dropping an accepted binding", () => {
        // Otherwise removing the binding exempts the module from the gate.
        expect(() =>
            assertCatalogBoundVerifierBytesUnchanged(
                { [key]: "a".repeat(64) },
                {},
            ),
        ).toThrow(/no longer binds accepted executable verifiers/);
    });

    it("accepts a module the accepted base never bound", () => {
        // A new case has no accepted bytes to drift from.
        expect(() =>
            assertCatalogBoundVerifierBytesUnchanged(
                {},
                { [key]: "b".repeat(64) },
            ),
        ).not.toThrow();
    });
});
