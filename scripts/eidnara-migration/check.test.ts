import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, type CheckKind } from "./check";

const digest = "a".repeat(64);
const commit = "b".repeat(40);

const valid: Record<CheckKind, Record<string, unknown>> = {
    "migration-receipts": {
        schema_version: 1,
        wave: "U2",
        sources: [{ repo: "commons", commit }],
        catalogs: [{ repo: "commons", commit }],
        property_impact: "migration/waves/U2/property-impact.json",
        architecture_impact: "migration/waves/U2/architecture-impact.json",
        files: [
            {
                source: "crates/cortexkit-lease/src/lib.rs",
                destination: "crates/lease/src/lib.rs",
                class: "human-authored",
                sha256: digest,
                doc_rigor: "review/doc-rigor/U2-lease-lib.json",
            },
        ],
        gates: { tests: "pass", release: "pass" },
        known_red: [
            {
                gate: "source-release",
                kind: "release",
                status: "not_run",
                justification: "Owner-hosted source release gate unavailable",
            },
        ],
    },
    "identity-allowlist": {
        schema_version: 1,
        identities: [
            {
                value: ".mc-host-coordination",
                class: "frozen-durable",
                rationale: "Existing writer exclusion path",
                evidence: ["release/mc-host-release.json"],
            },
        ],
    },
    "property-catalog": {
        schema_version: 1,
        records: [
            {
                slug: "lease-single-writer",
                status: "active",
                guarantee: "At most one writer holds the lease.",
                exact_check: "always(active_writers <= 1)",
                check_semantics: "always",
                evidence: ["docs/properties/lease/evidence/single-writer.md"],
                required_faults: ["contending process"],
                enabling_states: ["same lease key"],
                relationship: "mapped",
                exercised: "yes",
                check_status: "audited",
            },
        ],
    },
    "property-impact": {
        schema_version: 1,
        provenance: [{ repo: "commons", commit }],
        destination_commit: commit,
        touched_files: ["crates/lease/src/lib.rs"],
        records: [
            {
                slug: "lease-single-writer",
                classification: "core",
                disposition: "pass",
                relationship: "mapped",
                files: ["crates/lease/src/lib.rs"],
                strategy_decision: "cross-process integration test",
                audit_verdict: "pass",
                evidence_digest: digest,
                code_hash: digest,
                check_hash: digest,
                target_configurations: ["linux-x64"],
            },
        ],
    },
    "architecture-impact": {
        schema_version: 1,
        reports: [
            {
                phase: "pre-port",
                analyzed: { repo: "commons", commit, scope_hash: digest },
                report_hash: digest,
                candidates: [],
            },
            {
                phase: "post-integration",
                analyzed: { repo: "eidnara", commit, scope_hash: digest },
                report_hash: digest,
                candidates: [
                    {
                        title: "Deepen lease module",
                        strength: "Strong",
                        decision: "accepted",
                        modules: ["crates/lease"],
                        interface: "Lease::acquire",
                        implementation: "filesystem and process exclusion policy",
                        deletion_test: {
                            concentrates_complexity: true,
                            rationale: "Deleting module leaks exclusion policy into every caller.",
                        },
                        benefits: { locality: true, leverage: true, testability: true },
                        claims_flexibility: true,
                        adapters: ["filesystem", "in-memory test"],
                        specialist_routes: ["cohesion-coupling-and-modularity"],
                        final_verdict: "keep one interface and absorb policy",
                        implementation_evidence: "review/U2/deepen-lease.json",
                        property_impact: "migration/waves/U2/property-impact.json",
                        affected_properties: ["lease-single-writer"],
                    },
                ],
            },
        ],
    },
};

function copy(kind: CheckKind): Record<string, unknown> {
    return structuredClone(valid[kind]);
}

function architectureCandidate(value: Record<string, unknown>): Record<string, unknown> {
    const reports = value.reports as Record<string, unknown>[];
    return (reports[1].candidates as Record<string, unknown>[])[0];
}

describe("Eidnara migration prototype checks", () => {
    for (const kind of Object.keys(valid) as CheckKind[]) {
        test(`${kind} accepts a complete fixture`, () => {
            expect(validate(kind, copy(kind))).toEqual([]);
        });
    }

    test("migration receipts reject duplicate destinations", () => {
        const value = copy("migration-receipts");
        const files = value.files as Record<string, unknown>[];
        files.push(structuredClone(files[0]));
        expect(validate("migration-receipts", value)).toContain(
            "$.files[1].destination is duplicated",
        );
    });

    test("migration receipts reject malformed and blocking gate states", () => {
        const malformed = copy("migration-receipts");
        malformed.gates = { tests: ["pass"] };
        expect(validate("migration-receipts", malformed)).toContain(
            "$.gates.tests must be one of: pass, fail, cannot_run, not_run",
        );

        const blocking = copy("migration-receipts");
        blocking.gates = { tests: "fail" };
        expect(validate("migration-receipts", blocking)).toContain(
            "$.gates.tests blocks the wave with status fail",
        );
    });

    test("migration receipts validate known-red inheritance separately", () => {
        const malformed = copy("migration-receipts");
        malformed.known_red = "not-an-array";
        expect(validate("migration-receipts", malformed)).toContain(
            "$.known_red must be an array",
        );

        const duplicate = copy("migration-receipts");
        const entries = duplicate.known_red as Record<string, unknown>[];
        entries.push(structuredClone(entries[0]));
        expect(validate("migration-receipts", duplicate)).toContain(
            "$.known_red[1].gate is duplicated",
        );

        const overlap = copy("migration-receipts");
        const overlapEntry = (overlap.known_red as Record<string, unknown>[])[0];
        overlapEntry.gate = "release";
        expect(validate("migration-receipts", overlap)).toContain(
            "$.known_red[0].gate is also declared as a blocking gate",
        );

        const prototypeName = copy("migration-receipts");
        const prototypeEntry = (prototypeName.known_red as Record<string, unknown>[])[0];
        prototypeEntry.gate = "toString";
        expect(validate("migration-receipts", prototypeName)).toEqual([]);

        const empty = copy("migration-receipts");
        empty.gates = {};
        expect(validate("migration-receipts", empty)).toContain(
            "$.gates must declare at least one blocking gate",
        );

        const nonwaivable = copy("migration-receipts");
        const nonwaivableEntry = (nonwaivable.known_red as Record<string, unknown>[])[0];
        nonwaivableEntry.kind = "architecture";
        expect(validate("migration-receipts", nonwaivable)).toContain(
            "$.known_red[0].kind is nonwaivable",
        );
    });

    test("migration receipts scope the source-free exception to U1", () => {
        const u1 = copy("migration-receipts");
        u1.wave = "U1";
        u1.sources = [];
        expect(validate("migration-receipts", u1)).toEqual([]);

        const u2 = copy("migration-receipts");
        u2.sources = [];
        expect(validate("migration-receipts", u2)).toContain(
            "$.sources must contain at least one repository commit",
        );
    });

    test("identity allowlist rejects a legacy identity classified as renamed", () => {
        const value = copy("identity-allowlist");
        const identity = (value.identities as Record<string, unknown>[])[0];
        identity.class = "renamed";
        expect(validate("identity-allowlist", value)).toContain(
            "$.identities[0] retains a legacy identity but class is renamed",
        );
    });

    test("identity allowlist rejects an empty inventory", () => {
        expect(validate("identity-allowlist", { schema_version: 1, identities: [] })).toContain(
            "$.identities must contain at least one identity",
        );
    });

    test("identity and property proof links cannot be empty", () => {
        const identity = copy("identity-allowlist");
        ((identity.identities as Record<string, unknown>[])[0]).evidence = [];
        expect(validate("identity-allowlist", identity)).toContain(
            "$.identities[0].evidence must contain at least one entry",
        );

        const catalog = copy("property-catalog");
        ((catalog.records as Record<string, unknown>[])[0]).evidence = [];
        expect(validate("property-catalog", catalog)).toContain(
            "$.records[0].evidence must contain at least one entry",
        );
    });

    test("catalog rejects invalidated record without unreachability evidence", () => {
        const value = copy("property-catalog");
        const record = (value.records as Record<string, unknown>[])[0];
        record.status = "invalidated";
        delete record.unreachability_evidence;
        expect(validate("property-catalog", value)).toContain(
            "$.records[0].unreachability_evidence must be an array",
        );

        record.unreachability_evidence = [];
        expect(validate("property-catalog", value)).toContain(
            "$.records[0].unreachability_evidence must contain at least one entry",
        );
    });

    test("property impact rejects uncovered files and blocked core properties", () => {
        const value = copy("property-impact");
        value.touched_files = ["crates/lease/src/lib.rs", "crates/lease/src/key.rs"];
        const record = (value.records as Record<string, unknown>[])[0];
        record.disposition = "blocked";
        expect(validate("property-impact", value)).toEqual(
            expect.arrayContaining([
                "$.records[0] blocks the wave",
                "$.touched_files has uncovered file: crates/lease/src/key.rs",
            ]),
        );
    });

    test("property impact rejects empty and unaudited closures", () => {
        const empty = copy("property-impact");
        empty.touched_files = [];
        empty.records = [];
        expect(validate("property-impact", empty)).toEqual(
            expect.arrayContaining([
                "$.touched_files must contain at least one file",
                "$.records must contain at least one disposition",
            ]),
        );

        const unaudited = copy("property-impact");
        const record = (unaudited.records as Record<string, unknown>[])[0];
        record.audit_verdict = "unaudited";
        expect(validate("property-impact", unaudited)).toContain(
            "$.records[0].audit_verdict must equal pass",
        );
    });

    test("property impact rejects duplicate records and excluded-only coverage", () => {
        const duplicate = copy("property-impact");
        const records = duplicate.records as Record<string, unknown>[];
        records.push(structuredClone(records[0]));
        expect(validate("property-impact", duplicate)).toContain(
            "$.records[1].slug is duplicated",
        );

        const excluded = copy("property-impact");
        const record = (excluded.records as Record<string, unknown>[])[0];
        record.classification = "excluded-dropped";
        record.isolation_evidence = "Subsystem is absent by design";
        expect(validate("property-impact", excluded)).toContain(
            "$.touched_files has uncovered file: crates/lease/src/lib.rs",
        );
    });

    test("architecture impact rejects unresolved Strong candidates", () => {
        const value = copy("architecture-impact");
        const candidate = architectureCandidate(value);
        candidate.decision = "unresolved";
        expect(validate("architecture-impact", value)).toContain(
            "$.reports[1].candidates[0] is a Strong candidate that is neither accepted nor rejected",
        );

        candidate.decision = "recorded";
        expect(validate("architecture-impact", value)).toContain(
            "$.reports[1].candidates[0] is a Strong candidate that is neither accepted nor rejected",
        );
    });

    test("architecture impact rejects hypothetical flexibility", () => {
        const value = copy("architecture-impact");
        const candidate = architectureCandidate(value);
        candidate.adapters = ["filesystem"];
        expect(validate("architecture-impact", value)).toContain(
            "$.reports[1].candidates[0] claims flexibility without two current adapters",
        );
    });

    test("architecture impact requires a concrete deepening benefit", () => {
        const value = copy("architecture-impact");
        const candidate = architectureCandidate(value);
        candidate.benefits = { locality: false, leverage: false, testability: false };
        expect(validate("architecture-impact", value)).toContain(
            "$.reports[1].candidates[0] has no locality, leverage, or testability benefit",
        );
    });

    test("architecture impact validates every benefit field", () => {
        const value = copy("architecture-impact");
        const candidate = architectureCandidate(value);
        candidate.benefits = { locality: true, leverage: "yes", testability: 42 };
        expect(validate("architecture-impact", value)).toEqual(
            expect.arrayContaining([
                "$.reports[1].candidates[0].benefits.leverage must be a boolean",
                "$.reports[1].candidates[0].benefits.testability must be a boolean",
            ]),
        );
    });

    test("architecture impact requires both phases and accepted-change evidence", () => {
        const missingPhase = copy("architecture-impact");
        (missingPhase.reports as unknown[]).splice(0, 1);
        expect(validate("architecture-impact", missingPhase)).toContain(
            "$.reports is missing pre-port phase",
        );

        const incomplete = copy("architecture-impact");
        const candidate = architectureCandidate(incomplete);
        candidate.specialist_routes = [];
        delete candidate.implementation_evidence;
        expect(validate("architecture-impact", incomplete)).toEqual(
            expect.arrayContaining([
                "$.reports[1].candidates[0].implementation_evidence must be a non-empty string",
                "$.reports[1].candidates[0].specialist_routes must contain at least one route",
            ]),
        );

        const noProperties = copy("architecture-impact");
        architectureCandidate(noProperties).affected_properties = [];
        expect(validate("architecture-impact", noProperties)).toContain(
            "$.reports[1].candidates[0].affected_properties must contain at least one entry",
        );
    });

    test("schema and digest formats fail closed", () => {
        const schema = copy("identity-allowlist");
        schema.schema_version = 2;
        expect(validate("identity-allowlist", schema)).toContain("$.schema_version must equal 1");

        const receipt = copy("migration-receipts");
        ((receipt.files as Record<string, unknown>[])[0]).sha256 = "not-a-digest";
        expect(validate("migration-receipts", receipt)).toContain(
            "$.files[0].sha256 must be a lowercase SHA-256 digest",
        );
    });

    test("every CLI subcommand accepts its complete dry-run fixture", () => {
        const root = mkdtempSync(join(tmpdir(), "eidnara-migration-check-"));
        try {
            for (const kind of Object.keys(valid) as CheckKind[]) {
                const path = join(root, `${kind}.json`);
                writeFileSync(path, `${JSON.stringify(valid[kind])}\n`);
                const result = spawnSync(
                    "bun",
                    ["scripts/eidnara-migration/check.ts", kind, path],
                    { cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 30_000 },
                );
                expect(result.error).toBeUndefined();
                expect(result.status, `${kind}: ${result.stderr}`).toBe(0);
                expect(result.stdout).toContain(`${kind}: PASS`);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("CLI fails closed on invalid and missing inputs", () => {
        const root = mkdtempSync(join(tmpdir(), "eidnara-migration-check-invalid-"));
        try {
            const invalidPath = join(root, "invalid.json");
            writeFileSync(invalidPath, `${JSON.stringify({ schema_version: 1, identities: [] })}\n`);
            const invalid = spawnSync(
                "bun",
                ["scripts/eidnara-migration/check.ts", "migration-receipts", invalidPath],
                { cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 30_000 },
            );
            expect(invalid.status).toBe(1);
            expect(invalid.stderr).toContain("$.wave must be a non-empty string");

            const missing = spawnSync(
                "bun",
                ["scripts/eidnara-migration/check.ts", "identity-allowlist", join(root, "missing.json")],
                { cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 30_000 },
            );
            expect(missing.status).toBe(2);
            expect(missing.stderr).toContain("failed to read");

            const extra = spawnSync(
                "bun",
                ["scripts/eidnara-migration/check.ts", "identity-allowlist", invalidPath, "extra"],
                { cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 30_000 },
            );
            expect(extra.status).toBe(2);
            expect(extra.stderr).toContain("usage:");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
