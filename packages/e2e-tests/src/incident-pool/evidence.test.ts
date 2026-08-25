import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseIncidentCatalog, parseSourceInventory } from "./contract";
import {
    splitLedgerLines,
    validateIncidentHistory,
    compareWithAcceptedSnapshot,
} from "./history";
import {
    assertEvidenceSnapshot,
    assertMutationReplayResults,
    changedVerifiers,
    crossCheckEvidenceInventory,
    E2E_ROOT,
    EXPECTED_MUTATION_ARTIFACTS,
    EXPECTED_MUTATION_RECORDS,
    loadMutationEvidence,
    mutationRecordsBoundTo,
    REPO_ROOT,
    scanSources,
    validateEvidenceAndSources,
    verifyOwnershipMatrix,
    verifySourceCompleteness,
    type EvidenceView,
} from "./evidence";
import type { IncidentCatalog, SourceInventory } from "./contract";

const INCIDENTS_DIR = resolve(E2E_ROOT, "incidents");

function committedInventory(): SourceInventory {
    return parseSourceInventory(
        JSON.parse(
            readFileSync(join(INCIDENTS_DIR, "source-inventory.json"), "utf8"),
        ),
    );
}

function committedCatalog(): IncidentCatalog {
    return parseIncidentCatalog(
        JSON.parse(readFileSync(join(INCIDENTS_DIR, "catalog.json"), "utf8")),
    );
}

function committedView(): EvidenceView {
    return loadMutationEvidence();
}

function findClaim(inventory: SourceInventory, claimId: string) {
    for (const item of inventory.items) {
        const claim = item.claims.find((entry) => entry.id === claimId);
        if (claim) return claim;
    }
    throw new Error(`fixture claim ${claimId} not found`);
}

function findVariant(catalog: IncidentCatalog, variantId: string) {
    for (const family of catalog.families) {
        const variant = family.variants.find((entry) => entry.id === variantId);
        if (variant) return variant;
    }
    throw new Error(`fixture variant ${variantId} not found`);
}

describe("source inventory completeness (R1)", () => {
    it("covers every scanned source item and distinct claim exactly once", () => {
        const inventory = committedInventory();
        // Throws on any missing, extra, or drifted item/claim.
        verifySourceCompleteness(inventory, scanSources());

        const byId = new Map(
            inventory.items.map((item) => [item.id, item] as const),
        );
        const auditClaimIds = byId
            .get("src-audit-known-issues")!
            .claims.map((claim) => claim.id);
        expect(auditClaimIds).toHaveLength(65);
        expect(
            auditClaimIds.filter((id) => /^claim-audit-a\d+$/.test(id)),
        ).toHaveLength(54);
        expect(
            auditClaimIds.filter((id) => /^claim-audit-g\d+$/.test(id)),
        ).toEqual(["claim-audit-g1", "claim-audit-g2"]);
        expect(auditClaimIds).toContain("claim-audit-a6b");
        expect(auditClaimIds).toContain(
            "claim-audit-note-a14-update-session-facts-is-now-fully-retired-no-live-reader",
        );
        expect(byId.get("src-parity-findings-s2")!.claims).toHaveLength(16);
        expect(
            byId.get("src-thinking-block-adjudication")!.claims,
        ).toHaveLength(1);
        expect(byId.get("src-pi-todo-declared-red-suite")!.claims).toHaveLength(
            1,
        );
        expect(byId.get("src-bead-magic-context-x4l-9")!.claims).toHaveLength(
            2,
        );
    });

    it("records AUDITOR.md as one guide-level row with no finding claims", () => {
        const inventory = committedInventory();
        const guideRows = inventory.items.filter(
            (item) => item.source_path === "AUDITOR.md",
        );
        expect(guideRows).toHaveLength(1);
        expect(guideRows[0]!.claims).toHaveLength(0);
    });

    it("fails when a source item is removed from the inventory", () => {
        const inventory = committedInventory();
        inventory.items = inventory.items.filter(
            (item) => item.id !== "src-parity-findings-s2",
        );
        expect(() =>
            verifySourceCompleteness(inventory, scanSources()),
        ).toThrow(/source item missing from inventory: src-parity-findings-s2/);
    });

    it("fails when a single claim is removed from the inventory", () => {
        const inventory = committedInventory();
        const audit = inventory.items.find(
            (item) => item.id === "src-audit-known-issues",
        )!;
        audit.claims = audit.claims.filter(
            (claim) => claim.id !== "claim-audit-a44",
        );
        expect(() =>
            verifySourceCompleteness(inventory, scanSources()),
        ).toThrow(/source claim missing from inventory: claim-audit-a44/);
    });

    it("fails when the inventory carries a claim with no live source counterpart", () => {
        const inventory = committedInventory();
        const audit = inventory.items.find(
            (item) => item.id === "src-audit-known-issues",
        )!;
        audit.claims.push({
            id: "claim-audit-a99",
            content_digest: "a".repeat(64),
            disposition: "informational",
            rationale: "fabricated",
            family_links: [],
        });
        expect(() =>
            verifySourceCompleteness(inventory, scanSources()),
        ).toThrow(/claim-audit-a99 has no live source counterpart/);
    });

    it("rejects a free-form disposition outside the closed R2 vocabulary", () => {
        const raw = JSON.parse(
            readFileSync(join(INCIDENTS_DIR, "source-inventory.json"), "utf8"),
        ) as {
            items: Array<{ claims: Array<{ disposition: string }> }>;
        };
        raw.items[0]!.claims[0]!.disposition = "looks-suspicious";
        expect(() => parseSourceInventory(raw)).toThrow(
            /disposition: must be one of/,
        );
    });

    it("rejects an edited accepted inventory row against the repository baseline", () => {
        const accepted = {
            baseLabel: "accepted",
            inventoryText: readFileSync(
                join(INCIDENTS_DIR, "source-inventory.json"),
                "utf8",
            ),
            catalogText: readFileSync(
                join(INCIDENTS_DIR, "catalog.json"),
                "utf8",
            ),
            adjudicationLines: splitLedgerLines(
                readFileSync(
                    join(INCIDENTS_DIR, "adjudications.jsonl"),
                    "utf8",
                ),
            ),
            redactionLines: [] as string[],
        };
        const edited = JSON.parse(accepted.inventoryText) as {
            items: Array<{ claims: Array<{ rationale: string }> }>;
        };
        edited.items[0]!.claims[0]!.rationale = "quietly rewritten";
        const candidate = {
            ...accepted,
            inventoryText: JSON.stringify(edited),
        };
        expect(() => compareWithAcceptedSnapshot(accepted, candidate)).toThrow(
            /edited without an appended adjudication or emergency redaction/,
        );
    });
});

describe("mutation evidence normalization (R11)", () => {
    it("derives the accepted 13-artifact/21-record snapshot from live files", () => {
        const view = committedView();
        assertEvidenceSnapshot(view);
        expect(view.artifacts).toHaveLength(EXPECTED_MUTATION_ARTIFACTS);
        expect(view.records).toHaveLength(EXPECTED_MUTATION_RECORDS);
        expect(
            new Set(view.records.map((record) => record.evidenceId)).size,
        ).toBe(EXPECTED_MUTATION_RECORDS);
        // Both committed shapes normalize into the one view.
        expect(
            view.records.some((record) => record.shape === "mutations"),
        ).toBe(true);
        expect(
            view.records.some((record) => record.shape === "mutation_records"),
        ).toBe(true);
    });

    it("links every record to the live verifier it challenged", () => {
        const view = committedView();
        for (const record of view.records) {
            expect(view.verifierDigests[record.verifierPath]).toMatch(
                /^[0-9a-f]{64}$/,
            );
        }
        const byId = new Map(
            view.records.map((record) => [record.evidenceId, record] as const),
        );
        expect(byId.get("ev-fm-pi-1-mutate-rung-swap")!.verifierPath).toBe(
            "packages/e2e-tests/tests/pi-rust-degradation-arc-1.test.ts",
        );
        expect(byId.get("ev-fm-pi-4-mutate-rung-swap")!.verifierPath).toBe(
            "packages/e2e-tests/tests/pi-rust-degradation-arc-4.test.ts",
        );
        expect(byId.get("ev-dg-1-one-byte-input")!.verifierPath).toBe(
            "crates/mc-module/src/differential_goldens.rs",
        );
        expect(byId.get("ev-fm-oc-5-rung-deletion")!.verifierPath).toBe(
            "packages/e2e-tests/tests/rust-fm-oc-5.test.ts",
        );
    });

    it("agrees with the committed inventory's mutation claims", () => {
        crossCheckEvidenceInventory(committedInventory(), committedView());
    });

    it("rejects duplicated, malformed, unknown-shape, and orphan-verifier records", () => {
        const temp = mkdtempSync(join(tmpdir(), "incident-evidence-"));
        try {
            cpSync(resolve(E2E_ROOT, "mutations"), join(temp, "mutations"), {
                recursive: true,
            });

            const duplicated = JSON.parse(
                readFileSync(join(temp, "mutations", "fm-oc-1.json"), "utf8"),
            ) as { mutations: unknown[] };
            duplicated.mutations.push(structuredClone(duplicated.mutations[0]));
            writeFileSync(
                join(temp, "mutations", "fm-oc-1.json"),
                JSON.stringify(duplicated),
            );
            expect(() => loadMutationEvidence(temp, REPO_ROOT)).toThrow(
                /duplicate normalized evidence id ev-fm-oc-1-rung-swap/,
            );

            cpSync(
                resolve(E2E_ROOT, "mutations", "fm-oc-1.json"),
                join(temp, "mutations", "fm-oc-1.json"),
            );
            writeFileSync(
                join(temp, "mutations", "zz-unknown.json"),
                JSON.stringify({ drills: [] }),
            );
            expect(() => loadMutationEvidence(temp, REPO_ROOT)).toThrow(
                /unknown mutation artifact shape/,
            );

            writeFileSync(
                join(temp, "mutations", "zz-unknown.json"),
                JSON.stringify({
                    command: "bun test tests/rust-fm-oc-1.test.ts",
                    mutations: [{ nameless: true }],
                }),
            );
            expect(() => loadMutationEvidence(temp, REPO_ROOT)).toThrow(
                /name must be a non-empty string/,
            );

            writeFileSync(
                join(temp, "mutations", "zz-unknown.json"),
                JSON.stringify({
                    command:
                        "bun test tests/this-verifier-does-not-exist.test.ts",
                    mutations: [{ name: "ZZ_ORPHAN" }],
                }),
            );
            expect(() => loadMutationEvidence(temp, REPO_ROOT)).toThrow(
                /links a missing verifier packages\/e2e-tests\/tests\/this-verifier-does-not-exist\.test\.ts/,
            );
        } finally {
            rmSync(temp, { recursive: true, force: true });
        }
    });

    it("fails when a mutation link is duplicated into the inventory twice", () => {
        const inventory = committedInventory();
        const artifact = inventory.items.find(
            (item) => item.id === "src-mutation-goldens-dg-1",
        )!;
        // A second inventory row for the same normalized record is a duplicate
        // link even though its claim id is unique.
        artifact.claims.push({
            ...artifact.claims[0]!,
            id: "claim-mutation-dg-1-one-byte-input-copy",
        });
        expect(() =>
            verifySourceCompleteness(inventory, scanSources()),
        ).toThrow(/has no live source counterpart/);
    });
});

describe("ownership matrix (U3 approach 4)", () => {
    it("accepts the committed catalog only when every executable binding is live", () => {
        verifyOwnershipMatrix(committedInventory(), committedCatalog());
    });

    it("fails when an executable claim loses its owner", () => {
        const inventory = committedInventory();
        const catalog = committedCatalog();
        const family = catalog.families.find(
            (entry) => entry.id === "fam-embedding-freshness",
        )!;
        family.variants = family.variants.map((variant) => ({
            ...variant,
            source_claims: ["claim-audit-a5"],
        }));
        expect(() => verifyOwnershipMatrix(inventory, catalog)).toThrow(
            /executable claim claim-audit-a32 has no owner in the implementation matrix/,
        );
    });

    it("rejects a binding that names an existing Bun test instead of a scenario module", () => {
        const catalog = committedCatalog();
        const variant = findVariant(
            catalog,
            "var-parity-a1-pure-defer-stability",
        );
        variant.verifier_binding!.driver =
            "tests/cache-invariants.test.ts#driveFirstRenderPureDeferStability";
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalog),
        ).toThrow(
            /an existing Bun test alone cannot satisfy an executable binding/,
        );
    });

    it("rejects a live binding whose module or export is missing", () => {
        const catalog = committedCatalog();
        const variant = findVariant(
            catalog,
            "var-parity-a1-pure-defer-stability",
        );
        variant.verifier_binding!.driver =
            "src/incident-pool/scenarios/never-written.ts#driveX";
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalog),
        ).toThrow(/live binding names a missing module/);

        const catalog2 = committedCatalog();
        const variant2 = findVariant(
            catalog2,
            "var-parity-a1-pure-defer-stability",
        );
        variant2.verifier_binding!.driver =
            "src/incident-pool/scenarios/source-linked-regressions.ts#driveSomethingElse";
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalog2),
        ).toThrow(/does not export function driveSomethingElse/);
    });

    it("rejects comment-only text that looks like an exported function", () => {
        const relative = `src/incident-pool/scenarios/comment-only-${Date.now()}.ts`;
        const absolute = resolve(E2E_ROOT, relative);
        writeFileSync(
            absolute,
            "// export function driveFirstRenderPureDeferStability() {}\n",
        );
        try {
            const catalog = committedCatalog();
            const variant = findVariant(
                catalog,
                "var-parity-a1-pure-defer-stability",
            );
            variant.verifier_binding!.driver = `${relative}#driveFirstRenderPureDeferStability`;
            expect(() =>
                verifyOwnershipMatrix(committedInventory(), catalog),
            ).toThrow(
                /does not export function driveFirstRenderPureDeferStability/,
            );
        } finally {
            rmSync(absolute, { force: true });
        }
    });

    it("rejects any declared executable binding after rollout", () => {
        const catalog = committedCatalog();
        const variant = findVariant(catalog, "var-a5-archived-reobservation");
        variant.verifier_binding!.binding_status = "declared";
        variant.verifier_binding!.driver =
            "src/incident-pool/scenarios/source-linked-regressions.ts#driveArchivedReobservation";
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalog),
        ).toThrow(/requires a live verifier binding/);
    });

    it("requires reciprocal inventory and family ownership links", () => {
        const inventoryMissing = committedInventory();
        findClaim(inventoryMissing, "claim-audit-a5").family_links = [];
        expect(() =>
            verifyOwnershipMatrix(inventoryMissing, committedCatalog()),
        ).toThrow(/lacks reciprocal inventory family_link/);

        const catalogMissing = committedCatalog();
        const family = catalogMissing.families.find(
            (entry) => entry.id === "fam-archived-reobservation",
        )!;
        family.source_claims = [];
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalogMissing),
        ).toThrow(/lacks reciprocal family source_claim/);
    });

    it("rejects giving an unsupported claim an executable target (AE3)", () => {
        const catalog = committedCatalog();
        const variant = findVariant(catalog, "var-a5-archived-reobservation");
        variant.source_claims = [
            ...variant.source_claims,
            "claim-bead-wrong-dreamer-archival",
        ];
        expect(() =>
            verifyOwnershipMatrix(committedInventory(), catalog),
        ).toThrow(
            /unsupported claim claim-bead-wrong-dreamer-archival must not have an executable target/,
        );
    });
});

describe("adjudication-only provenance mismatches (AE3)", () => {
    it("keeps wrong-archive and inconsistent-historian-state non-executable and names the missing evidence", () => {
        const inventory = committedInventory();
        const catalog = committedCatalog();
        for (const [claimId, variantId] of [
            [
                "claim-bead-wrong-dreamer-archival",
                "var-wrong-dreamer-archival-claim",
            ],
            [
                "claim-bead-historian-inconsistent-state",
                "var-historian-inconsistent-state-claim",
            ],
        ] as const) {
            const claim = findClaim(inventory, claimId);
            expect(claim.disposition).toBe("unsupported");
            expect(claim.rationale).toContain("missing evidence");
            const variant = findVariant(catalog, variantId);
            expect(variant.lane).toBe("adjudication-only");
            expect(variant.verifier_binding).toBeNull();
            expect(variant.normative_checks).toHaveLength(0);
        }
    });
});

describe("synthetic-todo families", () => {
    it("keeps the five Rust variants in one family with distinct normative checks", () => {
        const catalog = committedCatalog();
        const family = catalog.families.find(
            (entry) => entry.id === "fam-synthetic-todo-handoff",
        )!;
        expect(family.variants).toHaveLength(5);
        const checkSets = family.variants.map((variant) =>
            variant.normative_checks.join(","),
        );
        expect(new Set(checkSets).size).toBe(5);
        for (const variant of family.variants) {
            expect(variant.lane).toBe("known-red");
            expect(variant.applicability!.harness).toBe("rust");
        }
        for (const dependent of family.variants.filter(
            (v) => v.id !== "var-todo-1-synthetic-injection",
        )) {
            expect(dependent.blocked_by).toEqual([
                "var-todo-1-synthetic-injection",
            ]);
        }
    });

    it("keeps the Pi declared-red suite as a separate family that cannot satisfy the Rust variants", () => {
        const catalog = committedCatalog();
        const rust = catalog.families.find(
            (entry) => entry.id === "fam-synthetic-todo-handoff",
        )!;
        const pi = catalog.families.find(
            (entry) => entry.id === "fam-pi-todo-gap",
        )!;
        expect(pi.id).not.toBe(rust.id);

        const rustClaims = new Set(
            rust.variants.flatMap((variant) => variant.source_claims),
        );
        const piClaims = new Set(
            pi.variants.flatMap((variant) => variant.source_claims),
        );
        for (const claim of piClaims) expect(rustClaims.has(claim)).toBe(false);

        const rustChecks = new Set(
            rust.variants.flatMap((variant) => variant.normative_checks),
        );
        for (const variant of pi.variants) {
            expect(variant.applicability!.harness).toBe("pi");
            for (const check of variant.normative_checks)
                expect(rustChecks.has(check)).toBe(false);
        }
    });
});

describe("verifier-change mutation replay gate (R14)", () => {
    it("requires no replay while verifier bytes match the accepted digests", () => {
        const view = committedView();
        expect(
            changedVerifiers(view.verifierDigests, view.verifierDigests),
        ).toEqual([]);
    });

    it("fails contributor verification when a bound mutation no longer produces the expected red result", () => {
        const view = committedView();
        const verifier = "packages/e2e-tests/tests/rust-fm-oc-1.test.ts";
        const changed = changedVerifiers(view.verifierDigests, {
            ...view.verifierDigests,
            [verifier]: "0".repeat(64),
        });
        expect(changed).toEqual([verifier]);

        const bound = mutationRecordsBoundTo(view, verifier);
        expect(bound.map((record) => record.evidenceId).sort()).toEqual([
            "ev-fm-oc-1-rung-deletion",
            "ev-fm-oc-1-rung-swap",
        ]);

        // Every bound crafted mutation replayed red: gate passes.
        assertMutationReplayResults(view, verifier, {
            "ev-fm-oc-1-rung-swap": true,
            "ev-fm-oc-1-rung-deletion": true,
        });
        // One mutation stopped producing red (or was skipped): gate fails.
        expect(() =>
            assertMutationReplayResults(view, verifier, {
                "ev-fm-oc-1-rung-swap": true,
                "ev-fm-oc-1-rung-deletion": false,
            }),
        ).toThrow(
            /ev-fm-oc-1-rung-deletion did not produce the expected red result/,
        );
        expect(() =>
            assertMutationReplayResults(view, verifier, {
                "ev-fm-oc-1-rung-swap": true,
            }),
        ).toThrow(/did not produce the expected red result/);
    });
});

describe("committed repository state", () => {
    it("validates the whole populated inventory, catalog, ledger, and evidence together", () => {
        const state = validateIncidentHistory({
            inventoryText: readFileSync(
                join(INCIDENTS_DIR, "source-inventory.json"),
                "utf8",
            ),
            catalogText: readFileSync(
                join(INCIDENTS_DIR, "catalog.json"),
                "utf8",
            ),
            adjudicationLines: splitLedgerLines(
                readFileSync(
                    join(INCIDENTS_DIR, "adjudications.jsonl"),
                    "utf8",
                ),
            ),
            redactionLines: splitLedgerLines(
                readFileSync(
                    join(INCIDENTS_DIR, "emergency-redactions.jsonl"),
                    "utf8",
                ),
            ),
        });
        const view = validateEvidenceAndSources(state.inventory, state.catalog);
        expect(view.records).toHaveLength(EXPECTED_MUTATION_RECORDS);

        // Every executable variant carries a fingerprint-bound baseline; red
        // baselines carry expected failed checks plus observation signatures.
        for (const family of state.catalog.families) {
            for (const variant of family.variants) {
                if (variant.lane === "adjudication-only") continue;
                const baseline = state.ledger.byIdentity.get(
                    variant.id,
                )?.latestBaseline;
                expect(baseline?.semantic_fingerprint).toBe(
                    variant.semantic_revision.fingerprint,
                );
                if (variant.lane === "known-red") {
                    expect(
                        baseline?.expected_failed_checks?.length,
                    ).toBeGreaterThan(0);
                    expect(baseline?.observation_signature).toMatch(
                        /^[0-9a-f]{64}$/,
                    );
                }
            }
        }
    });

    it("fails when the catalog references an orphan source claim", () => {
        const inventoryText = readFileSync(
            join(INCIDENTS_DIR, "source-inventory.json"),
            "utf8",
        );
        const catalog = JSON.parse(
            readFileSync(join(INCIDENTS_DIR, "catalog.json"), "utf8"),
        ) as {
            families: Array<{ source_claims: string[] }>;
        };
        catalog.families[0]!.source_claims.push("claim-orphan-ghost");
        expect(() =>
            validateIncidentHistory({
                inventoryText,
                catalogText: JSON.stringify(catalog),
                adjudicationLines: splitLedgerLines(
                    readFileSync(
                        join(INCIDENTS_DIR, "adjudications.jsonl"),
                        "utf8",
                    ),
                ),
                redactionLines: [],
            }),
        ).toThrow(/unknown source claim claim-orphan-ghost/);
    });
});
