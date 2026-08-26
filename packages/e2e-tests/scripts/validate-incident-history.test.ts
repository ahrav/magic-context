import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    deriveTrustedAcceptedCommit,
    loadHistorySnapshot,
    loadHistorySnapshotFromGit,
    parseIncidentHistoryArgs,
    validateAgainstAcceptedDirectory,
    validateAgainstTrustedCiBase,
    validateIncidentDirectory,
    INCIDENTS_DIR,
    type GitRunner,
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
                        applicability: {
                            harness: "opencode",
                            omitted: [
                                {
                                    harness: "pi",
                                    reason: "fixture: not applicable",
                                },
                                {
                                    harness: "rust",
                                    reason: "fixture: not applicable",
                                },
                            ],
                        },
                        semantic_revision: {
                            id: "rev-red-one",
                            fingerprint: HEX("c"),
                        },
                        normative_checks: ["check-red-holds"],
                        verifier_binding: {
                            driver: "demo/driver",
                            verifier: "demo/verifier",
                            binding_status: "declared",
                            invalid_state_evidence: [
                                "false success narration fixture",
                            ],
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

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const SECOND_PARENT_SHA = "3".repeat(40);

function fakeGit(
    options: {
        head?: string;
        parents?: string[];
        ancestor?: boolean;
        shallow?: boolean;
    } = {},
): { git: GitRunner; calls: string[][] } {
    const head = options.head ?? HEAD_SHA;
    const parents = options.parents ?? [BASE_SHA, SECOND_PARENT_SHA];
    const calls: string[][] = [];
    let shallow = options.shallow ?? false;
    const git: GitRunner = (args) => {
        calls.push([...args]);
        if (args[0] === "fetch") {
            if (args.includes("--unshallow")) shallow = false;
            return { status: 0, stdout: "", stderr: "" };
        }
        if (args.join(" ") === "rev-parse HEAD") {
            return { status: 0, stdout: `${head}\n`, stderr: "" };
        }
        if (args.join(" ") === "rev-parse --is-shallow-repository") {
            return {
                status: 0,
                stdout: `${shallow ? "true" : "false"}\n`,
                stderr: "",
            };
        }
        if (args[0] === "cat-file") {
            return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "merge-base") {
            return {
                status: options.ancestor === false ? 1 : 0,
                stdout: "",
                stderr: "",
            };
        }
        if (args[0] === "rev-list") {
            return {
                status: 0,
                stdout: `${head} ${parents.join(" ")}\n`,
                stderr: "",
            };
        }
        return { status: 1, stdout: "", stderr: "unexpected fake git call" };
    };
    return { git, calls };
}

function pullRequestEvent(base: string = BASE_SHA): Record<string, unknown> {
    return { pull_request: { base: { sha: base } } };
}

function pushEvent(before: string = BASE_SHA): Record<string, unknown> {
    return {
        before,
        after: HEAD_SHA,
        ref: "refs/heads/main",
        repository: { default_branch: "main" },
    };
}

describe("trusted accepted-base derivation", () => {
    it("accepts a pull-request merge ref rooted at the payload base SHA", () => {
        const { git, calls } = fakeGit();
        expect(
            deriveTrustedAcceptedCommit({
                eventName: "pull_request",
                event: pullRequestEvent(),
                githubSha: HEAD_SHA,
                githubRef: "refs/pull/7/merge",
                githubRefProtected: "false",
                repoRoot: "/fixture",
                git,
            }),
        ).toBe(BASE_SHA);
        expect(calls).toContainEqual([
            "fetch",
            "--no-tags",
            "--force",
            "origin",
            BASE_SHA,
        ]);
    });

    it("accepts a protected default-branch push predecessor", () => {
        const { git } = fakeGit({ parents: [BASE_SHA] });
        expect(
            deriveTrustedAcceptedCommit({
                eventName: "push",
                event: pushEvent(),
                githubSha: HEAD_SHA,
                githubRef: "refs/heads/main",
                githubRefProtected: "true",
                repoRoot: "/fixture",
                git,
            }),
        ).toBe(BASE_SHA);
    });

    it("explicitly unshallows before checking ancestry", () => {
        const { git, calls } = fakeGit({ shallow: true });
        deriveTrustedAcceptedCommit({
            eventName: "pull_request",
            event: pullRequestEvent(),
            githubSha: HEAD_SHA,
            githubRef: "refs/pull/7/merge",
            githubRefProtected: "false",
            repoRoot: "/fixture",
            git,
        });
        expect(calls).toContainEqual([
            "fetch",
            "--no-tags",
            "--unshallow",
            "origin",
        ]);
    });

    it("fails closed when the event payload is missing", () => {
        const { git } = fakeGit();
        expect(() =>
            deriveTrustedAcceptedCommit({
                eventName: "pull_request",
                event: {},
                githubSha: HEAD_SHA,
                githubRef: "refs/pull/7/merge",
                githubRefProtected: "false",
                repoRoot: "/fixture",
                git,
            }),
        ).toThrow(/pull_request must be an object/);
        expect(() => validateAgainstTrustedCiBase({})).toThrow(
            /requires GITHUB_EVENT_NAME/,
        );
    });

    it("rejects an all-zero accepted base", () => {
        const { git } = fakeGit();
        expect(() =>
            deriveTrustedAcceptedCommit({
                eventName: "push",
                event: pushEvent("0".repeat(40)),
                githubSha: HEAD_SHA,
                githubRef: "refs/heads/main",
                githubRefProtected: "true",
                repoRoot: "/fixture",
                git,
            }),
        ).toThrow(/non-zero 40-character commit SHA/);
    });

    it("rejects every CI base or snapshot override attempt", () => {
        for (const override of [
            ["--ci", "--base", BASE_SHA],
            ["--ci", "--accepted", "/tmp/accepted"],
            ["--ci", "--dir", "/tmp/candidate"],
        ]) {
            expect(() => parseIncidentHistoryArgs(override)).toThrow(
                /accepts no caller-supplied/,
            );
        }
    });

    it("rejects a fetched commit that is not an ancestor", () => {
        const { git } = fakeGit({ ancestor: false });
        expect(() =>
            deriveTrustedAcceptedCommit({
                eventName: "push",
                event: pushEvent(),
                githubSha: HEAD_SHA,
                githubRef: "refs/heads/main",
                githubRefProtected: "true",
                repoRoot: "/fixture",
                git,
            }),
        ).toThrow(/not an ancestor/);
    });

    it("uses an empty accepted snapshot only when ls-tree proves no incident paths", () => {
        const git: GitRunner = (args) => ({
            status: args[0] === "ls-tree" ? 0 : 128,
            stdout: "",
            stderr: args[0] === "ls-tree" ? "" : "unexpected git show",
        });
        const snapshot = loadHistorySnapshotFromGit("/fixture", BASE_SHA, git);
        expect(JSON.parse(snapshot.inventoryText)).toEqual({
            schema: "incident-source-inventory/v1",
            items: [],
        });
        expect(JSON.parse(snapshot.catalogText)).toEqual({
            schema: "incident-catalog/v1",
            families: [],
        });
        expect(snapshot.adjudicationLines).toEqual([]);
        expect(snapshot.redactionLines).toEqual([]);
    });

    it("fails closed when the trusted tree lists only part of incident history", () => {
        const git: GitRunner = (args) => ({
            status: 0,
            stdout:
                args[0] === "ls-tree"
                    ? "packages/e2e-tests/incidents/source-inventory.json\n"
                    : "{}",
            stderr: "",
        });
        expect(() =>
            loadHistorySnapshotFromGit("/fixture", BASE_SHA, git),
        ).toThrow(/only part of incident history/);
    });

    it("fails closed on ls-tree errors and listed files that git show cannot read", () => {
        const treeFailure: GitRunner = () => ({
            status: 128,
            stdout: "",
            stderr: "object database unavailable",
        });
        expect(() =>
            loadHistorySnapshotFromGit("/fixture", BASE_SHA, treeFailure),
        ).toThrow(/could not inspect trusted incident baseline/);

        const paths = [
            "source-inventory.json",
            "catalog.json",
            "adjudications.jsonl",
            "emergency-redactions.jsonl",
        ].map((name) => `packages/e2e-tests/incidents/${name}`);
        const showFailure: GitRunner = (args) => {
            if (args[0] === "ls-tree") {
                return {
                    status: 0,
                    stdout: `${paths.join("\n")}\n`,
                    stderr: "",
                };
            }
            if (args.join(" ").includes("catalog.json")) {
                return { status: 128, stdout: "", stderr: "misc git failure" };
            }
            return { status: 0, stdout: "{}", stderr: "" };
        };
        expect(() =>
            loadHistorySnapshotFromGit("/fixture", BASE_SHA, showFailure),
        ).toThrow(/could not read trusted incident file.*catalog.json/);
    });
});

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
            expect(
                state.ledger.byIdentity.get("var-red-one")!.latestBaseline!
                    .event_id,
            ).toBe("adj-red-one");
        });
    });

    it("fails a directory with an unknown contract field", () => {
        const files = fixtureFiles();
        const catalog = JSON.parse(files["catalog.json"]) as {
            families: Record<string, unknown>[];
        };
        catalog.families[0]!.owner = "someone";
        files["catalog.json"] = JSON.stringify({
            schema: "incident-catalog/v1",
            ...catalog,
        });
        withFixtureDir(files, (dir) => {
            expect(() => validateIncidentDirectory(dir)).toThrow(
                /must contain exactly/,
            );
        });
    });

    it("fails closed on a malformed ledger line without folding later events", () => {
        const files = fixtureFiles();
        files["adjudications.jsonl"] =
            `not json\n${files["adjudications.jsonl"]}`;
        withFixtureDir(files, (dir) => {
            expect(() => validateIncidentDirectory(dir)).toThrow(
                /adjudications\[0\] is not valid JSON/,
            );
        });
    });

    it("fails when an artifact file is missing", () => {
        const files = fixtureFiles();
        withFixtureDir(files, (dir) => {
            rmSync(join(dir, "catalog.json"), { force: true });
            expect(() => validateIncidentDirectory(dir)).toThrow(
                /could not read/,
            );
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
            appended["adjudications.jsonl"] +=
                `${JSON.stringify(resolution)}\n`;
            withFixtureDir(appended, (candidateDir) => {
                const state = validateAgainstAcceptedDirectory(
                    acceptedDir,
                    "base-1",
                    candidateDir,
                );
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
                expect(() =>
                    validateAgainstAcceptedDirectory(
                        acceptedDir,
                        "base-1",
                        candidateDir,
                    ),
                ).toThrow(/accepted source claim edited/);
            });
        });
    });

    it("exposes the same comparison used by compareWithAcceptedSnapshot", () => {
        withFixtureDir(fixtureFiles(), (dir) => {
            const accepted = loadHistorySnapshot(dir, "base-1");
            expect(() =>
                compareWithAcceptedSnapshot(accepted, accepted),
            ).not.toThrow();
        });
    });
});
