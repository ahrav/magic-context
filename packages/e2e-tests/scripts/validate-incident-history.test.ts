import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    loadHistorySnapshot,
    validateAgainstAcceptedDirectory,
    validateIncidentDirectory,
    INCIDENTS_DIR,
} from "./validate-incident-history";
import { compareWithAcceptedSnapshot } from "../src/incident-pool/history";

const HEX = (fill: string): string => fill.repeat(64);

interface FixtureFiles {
    "source-inventory.json": string;
    "catalog.json": string;
    "adjudications.jsonl": string;
    "emergency-redactions.jsonl": string;
}

function fixtureFiles(): FixtureFiles {
    const inventory = {
        schema: "incident-source-inventory/v1",
        items: [
            {
                id: "src-audit",
                source_path: "docs/AUDIT-KNOWN-ISSUES.md",
                content_digest: HEX("f"),
                claims: [
                    {
                        id: "claim-red-one",
                        content_digest: HEX("2"),
                        disposition: "executable_known_defect",
                        rationale: "demonstrated defect reproduction",
                        family_links: ["fam-demo"],
                    },
                ],
            },
        ],
    };
    const catalog = {
        schema: "incident-catalog/v1",
        families: [
            {
                id: "fam-demo",
                title: "Demo incident family",
                source_claims: ["claim-red-one"],
                variants: [
                    {
                        id: "var-red-one",
                        lane: "known-red",
                        source_claims: ["claim-red-one"],
                        applicability: { harness: "opencode", omitted: [] },
                        semantic_revision: { id: "rev-red-one", fingerprint: HEX("c") },
                        normative_checks: ["check-red-holds"],
                        verifier_binding: {
                            driver: "demo/driver",
                            verifier: "demo/verifier",
                            invalid_state_evidence: ["false success narration fixture"],
                        },
                        blocked_by: [],
                        evidence_refs: [],
                    },
                ],
            },
        ],
    };
    const baseline = {
        schema: "incident-adjudication/v1",
        event_id: "adj-red-one",
        identity: "var-red-one",
        seq: 1,
        kind: "baseline",
        baseline_verdict: "red",
        semantic_fingerprint: HEX("c"),
        expected_failed_checks: ["check-red-holds"],
        observation_signature: HEX("d"),
        rationale: "reviewed red baseline",
        source_revision: "audit-2026-08-24",
        supersedes: null,
    };
    return {
        "source-inventory.json": JSON.stringify(inventory, null, 4),
        "catalog.json": JSON.stringify(catalog, null, 4),
        "adjudications.jsonl": `${JSON.stringify(baseline)}\n`,
        "emergency-redactions.jsonl": "",
    };
}

function writeFixtureDir(files: FixtureFiles): string {
    const dir = mkdtempSync(join(tmpdir(), "incident-history-"));
    for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(dir, name), text);
    }
    return dir;
}

function withFixtureDir(files: FixtureFiles, run: (dir: string) => void): void {
    const dir = writeFixtureDir(files);
    try {
        run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("validate-incident-history script", () => {
    it("validates the committed incidents directory", () => {
        const state = validateIncidentDirectory();
        expect(state.inventory.schema).toBe("incident-source-inventory/v1");
        expect(state.catalog.schema).toBe("incident-catalog/v1");
    });

    it("loads a snapshot with the four expected files", () => {
        const snapshot = loadHistorySnapshot(INCIDENTS_DIR, "working");
        expect(snapshot.baseLabel).toBe("working");
        expect(Array.isArray(snapshot.adjudicationLines)).toBe(true);
        expect(Array.isArray(snapshot.redactionLines)).toBe(true);
    });

    it("validates a populated fixture directory", () => {
        withFixtureDir(fixtureFiles(), (dir) => {
            const state = validateIncidentDirectory(dir);
            expect(state.events).toHaveLength(1);
            expect(state.ledger.byIdentity.get("var-red-one")!.latestBaseline!.event_id).toBe("adj-red-one");
        });
    });

    it("fails a directory with an unknown contract field", () => {
        const files = fixtureFiles();
        const catalog = JSON.parse(files["catalog.json"]) as { families: Record<string, unknown>[] };
        catalog.families[0]!.owner = "someone";
        files["catalog.json"] = JSON.stringify({ schema: "incident-catalog/v1", ...catalog });
        withFixtureDir(files, (dir) => {
            expect(() => validateIncidentDirectory(dir)).toThrow(/must contain exactly/);
        });
    });

    it("fails closed on a malformed ledger line without folding later events", () => {
        const files = fixtureFiles();
        files["adjudications.jsonl"] = `not json\n${files["adjudications.jsonl"]}`;
        withFixtureDir(files, (dir) => {
            expect(() => validateIncidentDirectory(dir)).toThrow(/adjudications\[0\] is not valid JSON/);
        });
    });

    it("fails when an artifact file is missing", () => {
        const files = fixtureFiles();
        withFixtureDir(files, (dir) => {
            rmSync(join(dir, "catalog.json"), { force: true });
            expect(() => validateIncidentDirectory(dir)).toThrow(/could not read/);
        });
    });

    it("compares a candidate directory against an accepted snapshot directory", () => {
        const acceptedFiles = fixtureFiles();
        withFixtureDir(acceptedFiles, (acceptedDir) => {
            const appended = fixtureFiles();
            const resolution = {
                schema: "incident-adjudication/v1",
                event_id: "adj-red-two",
                identity: "var-red-one",
                seq: 2,
                kind: "resolution",
                baseline_verdict: null,
                semantic_fingerprint: null,
                expected_failed_checks: null,
                observation_signature: null,
                rationale: "verifier passed on a candidate fix",
                source_revision: "audit-2026-08-24",
                supersedes: null,
            };
            appended["adjudications.jsonl"] += `${JSON.stringify(resolution)}\n`;
            withFixtureDir(appended, (candidateDir) => {
                const state = validateAgainstAcceptedDirectory(acceptedDir, "base-1", candidateDir);
                expect(state.events).toHaveLength(2);
            });

            const edited = fixtureFiles();
            const inventory = JSON.parse(edited["source-inventory.json"]) as {
                items: { claims: { rationale: string }[] }[];
            };
            inventory.items[0]!.claims[0]!.rationale = "silently rewritten";
            edited["source-inventory.json"] = JSON.stringify({
                schema: "incident-source-inventory/v1",
                items: inventory.items,
            });
            withFixtureDir(edited, (candidateDir) => {
                expect(() => validateAgainstAcceptedDirectory(acceptedDir, "base-1", candidateDir)).toThrow(
                    /accepted source claim edited/,
                );
            });
        });
    });

    it("exposes the same comparison used by compareWithAcceptedSnapshot", () => {
        withFixtureDir(fixtureFiles(), (dir) => {
            const accepted = loadHistorySnapshot(dir, "base-1");
            expect(() => compareWithAcceptedSnapshot(accepted, accepted)).not.toThrow();
        });
    });
});
