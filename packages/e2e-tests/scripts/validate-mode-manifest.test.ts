import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseIncidentCatalog } from "../src/incident-pool/contract";
import {
    assertSrcTestsClassified,
    incidentUnitFiles,
    prospectiveUnitFiles,
    standaloneFilesForSelection,
} from "./run-test-selection";
import {
    E2E_ROOT,
    filesForMode,
    validateGreenIncidentWrapperSource,
    validateGreenPackageScripts,
    validateManifestDocument,
    validateModeManifest,
    type ModeManifest,
} from "./validate-mode-manifest";

const validation = validateModeManifest();
const catalog = parseIncidentCatalog(
    JSON.parse(
        readFileSync(resolve(E2E_ROOT, "incidents", "catalog.json"), "utf8"),
    ),
);
const greenWrapperSource = readFileSync(
    resolve(E2E_ROOT, "tests", "incident-pool-green.test.ts"),
    "utf8",
);

function manifestWith(entries: ModeManifest["entries"]): ModeManifest {
    return {
        schema: 1,
        header: "test manifest",
        entries,
    };
}

describe("mode manifest validator", () => {
    it("covers every live e2e test exactly once", () => {
        expect(validation.files.length).toBe(61);
        expect(validation.manifest.entries).toHaveLength(
            validation.files.length,
        );
        expect(
            new Set(validation.manifest.entries.map((entry) => entry.path))
                .size,
        ).toBe(validation.files.length);
        expect(
            validation.manifest.entries.map((entry) => entry.path).sort(),
        ).toEqual(validation.files);
    });

    it("derives separate TS and Rust invocation lists", () => {
        const ts = filesForMode(validation, "ts");
        const rust = filesForMode(validation, "rust");
        expect(ts).toHaveLength(42);
        expect(rust).toHaveLength(31);
        expect(ts.filter((path) => path.startsWith("tests/pi-")).length).toBe(
            21,
        );
        expect(filesForMode(validation, "ts", "opencode")).toHaveLength(21);
        expect(filesForMode(validation, "ts", "pi")).toHaveLength(21);
        expect(new Set([...ts, ...rust]).size).toBe(validation.files.length);
        expect(filesForMode(validation, "ts", "pi")).not.toContain(
            "tests/pi-todo-synthesis.test.ts",
        );
        expect(rust).not.toContain("tests/todo-synthesis.test.ts");
    });

    it("rejects a missing, duplicated, or dead manifest path", () => {
        const entries = validation.manifest.entries;
        expect(() =>
            validateManifestDocument(
                manifestWith(entries.slice(0, -1)),
                validation.files,
            ),
        ).toThrow(/missing manifest entries/);
        expect(() =>
            validateManifestDocument(
                manifestWith([...entries, entries[0]!]),
                validation.files,
            ),
        ).toThrow(/duplicate manifest entry/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    ...entries.slice(0, -1),
                    {
                        ...entries.at(-1)!,
                        path: "tests/not-live.test.ts",
                    },
                ]),
                validation.files,
            ),
        ).toThrow(/dead or out-of-scope/);
    });

    it("accepts a both-modes entry in both invocation lists", () => {
        const entries = validation.manifest.entries;
        const both = validateManifestDocument(
            manifestWith([
                {
                    ...entries[0]!,
                    tier: "both-modes",
                    invocation: { ts: true, rust: true },
                    contract_refs: ["PARITY.md"],
                },
                ...entries.slice(1),
            ]),
            validation.files,
        );
        expect(filesForMode(both, "ts")).toContain(entries[0]!.path);
        expect(filesForMode(both, "rust")).toContain(entries[0]!.path);
    });

    it("accepts only complete canonical green wrapper arrays", () => {
        const selected = validateGreenIncidentWrapperSource(
            greenWrapperSource,
            catalog,
        );
        expect(selected).toContain("var-a5-archived-reobservation");
        expect(selected).toContain("var-parity-a3-ctx-reduce-survival");

        expect(() =>
            validateGreenIncidentWrapperSource(
                greenWrapperSource.replace(
                    '"var-a5-archived-reobservation",',
                    "",
                ),
                catalog,
            ),
        ).toThrow(/must equal complete catalog green set/);
        expect(() =>
            validateGreenIncidentWrapperSource(
                greenWrapperSource.replace(
                    '"var-a5-archived-reobservation",',
                    '// "var-a5-archived-reobservation",',
                ),
                catalog,
            ),
        ).toThrow(/must equal complete catalog green set/);
        expect(() =>
            validateGreenIncidentWrapperSource(
                greenWrapperSource.replace(
                    '"var-a5-archived-reobservation",',
                    '"var-a32-stale-embedding-recall",',
                ),
                catalog,
            ),
        ).toThrow(/known-red registry ID/);
        expect(() =>
            validateGreenIncidentWrapperSource(
                `import { parityPiTodoIncidentCases } from "../src/incident-pool/scenarios/parity-pi-todo";\n${greenWrapperSource}`,
                catalog,
            ),
        ).toThrow(/known-red-only scenario module/);
    });

    it("keeps incident-unit selection closed over manifest negative tests", () => {
        expect(incidentUnitFiles()).toEqual(
            expect.arrayContaining([
                "scripts/check-rust-prerequisites.test.ts",
                "scripts/validate-incident-history.test.ts",
                "scripts/validate-incident-verifiers.test.ts",
                "scripts/validate-mode-manifest.test.ts",
            ]),
        );
    });

    it("selects every prospective unit and classifies every src test", () => {
        expect(prospectiveUnitFiles()).toEqual(
            expect.arrayContaining([
                "src/prospective-holdout/contract.test.ts",
                "src/prospective-holdout/graduation.test.ts",
                "scripts/prospective-holdout.test.ts",
            ]),
        );
        expect(() => assertSrcTestsClassified()).not.toThrow();
    });

    it("owns OpenCode oracle units only in TypeScript OpenCode selections", () => {
        const opencodeOnly = [
            "src/oracle-arms/presets.test.ts",
            "src/oracle-arms/scripted-ctx-search.test.ts",
        ];
        expect(standaloneFilesForSelection("ts", "opencode")).toEqual(
            expect.arrayContaining(opencodeOnly),
        );
        for (const file of opencodeOnly) {
            expect(standaloneFilesForSelection("ts", "pi")).not.toContain(file);
            expect(standaloneFilesForSelection("rust", "all")).not.toContain(file);
        }
        for (const files of [
            standaloneFilesForSelection("ts", "opencode"),
            standaloneFilesForSelection("ts", "pi"),
            standaloneFilesForSelection("rust", "all"),
        ]) {
            expect(files).toContain("src/oracle-arms/seed-gold-memories.test.ts");
        }
    });

    it("rejects broad-glob green package scripts", () => {
        const pkg = JSON.parse(
            readFileSync(resolve(E2E_ROOT, "package.json"), "utf8"),
        ) as { scripts: Record<string, string> };
        pkg.scripts["test:rust-e2e"] = "bun test tests/rust-*.test.ts";
        expect(() => validateGreenPackageScripts(pkg)).toThrow(
            /must derive its exact file list/,
        );
    });

    it("rejects invalid tiers and a both-modes entry missing an invocation", () => {
        const entries = validation.manifest.entries;
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "not-a-tier" as never,
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invalid classification/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "both-modes",
                        invocation: { ts: true, rust: false },
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invocation disagrees with both-modes/);
    });
});
