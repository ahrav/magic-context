import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HARD_NEGATIVE_FAMILIES, buildReleaseTuple, parseScenario } from "./contract";
import { RELEASE_FILES, loadRelease, promoteRelease } from "./promote";
import { validScenarioRaw } from "./test-support";

function corpusRaw(count = 10): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => {
        const raw = validScenarioRaw();
        raw.id = `hse-scenario-${index}`;
        // Cycle the declared family (and its matching expected-absent tag)
        // so any fixture corpus of >= 7 scenarios satisfies the corpus-level
        // hard-negative family-coverage lint.
        const family = HARD_NEGATIVE_FAMILIES[index % HARD_NEGATIVE_FAMILIES.length];
        raw.families = [family];
        const gold = raw.gold as { expectedAbsent: Array<{ family: string }> };
        gold.expectedAbsent[0].family = family;
        return raw;
    });
}

function approvalsFor(scenariosRaw: Record<string, unknown>[]): Record<string, unknown>[] {
    const tuple = buildReleaseTuple(scenariosRaw.map((raw) => parseScenario(raw)));
    const fingerprint = canonicalFingerprint(tuple);
    return [
        { kind: "privacy", approver: "operator-a", releaseTupleFingerprint: fingerprint },
        { kind: "gold-intent", approver: "operator-b", releaseTupleFingerprint: fingerprint },
    ];
}

function withRoot(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "historian-eval-promote-test-"));
    try {
        run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

/** Canonical digest of a whole directory tree: sorted relative paths + bytes. */
function treeDigest(dir: string): string {
    const hash = createHash("sha256");
    const walk = (relative: string): void => {
        const absolute = join(dir, relative);
        if (statSync(absolute).isDirectory()) {
            for (const entry of readdirSync(absolute).sort()) walk(join(relative, entry));
            return;
        }
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(absolute));
    };
    walk(".");
    return hash.digest("hex");
}

describe("promoteRelease", () => {
    test("promotes a clean draft; the release loads back through the strict consumer path", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            expect(releaseDir).toBe(join(root, "v1"));
            expect(readdirSync(root)).toEqual(["v1"]);
            const loaded = loadRelease(releaseDir);
            expect(loaded.scenarios).toHaveLength(10);
            expect(loaded.mutationEvidence.green).toBe(true);
            expect(canonicalFingerprint(loaded.manifest.releaseTuple)).toBe(
                canonicalFingerprint(buildReleaseTuple(loaded.scenarios)),
            );
        });
    });

    test("rejects missing approval, duplicate approval kind, and stale fingerprints", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            const base = { scenarios, releasesRoot: root, releaseVersion: "v1" };

            expect(() => promoteRelease({ ...base, approvals: [approvals[0]] })).toThrow(/missing/);
            expect(() => promoteRelease({ ...base, approvals: [approvals[0], approvals[0]] })).toThrow(
                /duplicate-kind/,
            );
            const stale = JSON.parse(JSON.stringify(approvals));
            stale[0].releaseTupleFingerprint = "0".repeat(64);
            expect(() => promoteRelease({ ...base, approvals: stale })).toThrow(/stale-or-foreign-tuple/);
            // Free-form approval metadata rejects (exact keys).
            const noisy = JSON.parse(JSON.stringify(approvals));
            noisy[1].note = "lgtm";
            expect(() => promoteRelease({ ...base, approvals: noisy })).toThrow(/fields-invalid/);
            expect(readdirSync(root)).toEqual([]);
        });
    });

    test("rejects approvals bound to different content (scenario edited after approval)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            (scenarios[0].transcript as { turns: Array<{ user: string }> }).turns[0].user = "edited after approval";
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/stale-or-foreign-tuple/);
        });
    });

    test("gold edits after approval re-identify the scenario (gold is inside the fingerprint)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            (
                scenarios[0].gold as { expectedClaims: Array<{ predicate: { value: string } }> }
            ).expectedClaims[0].predicate.value = "weakened predicate";
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/stale-or-foreign-tuple/);
        });
    });

    test("refuses a corpus whose recomputed mutation battery is not green", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            // A one-character predicate survives its own near-miss
            // perturbation ("a" is a substring of "a-alt-"), so the battery
            // flags the matcher as non-discriminating; lint stays clean.
            (
                scenarios[0].gold as { expectedClaims: Array<{ predicate: { value: string } }> }
            ).expectedClaims[0].predicate.value = "a";
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: "v1",
                }),
            ).toThrow(/mutation-evidence\.hse-scenario-0: not-green/);
        });
    });

    test("privacy scan runs before any parser and operator deny lists flow through", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            (scenarios[0].transcript as { turns: Array<{ user: string }> }).turns[0].user =
                "the key lives at /home/someone/secrets.pem";
            // Malformed schema on the same artifact: the privacy diagnostic
            // must win because the scan runs first.
            delete scenarios[0].probes;
            expect(() =>
                promoteRelease({ scenarios, approvals: [], releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/privacy\./);

            const clean = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios: clean,
                    approvals: approvalsFor(clean),
                    releasesRoot: root,
                    releaseVersion: "v1",
                    forbiddenTokens: ["in-process LRU"],
                }),
            ).toThrow(/privacy\.forbidden-token/);
        });
    });

    test("rejects a corpus outside the 10-30 budget", () => {
        withRoot((root) => {
            const scenarios = corpusRaw(3);
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: "v1",
                }),
            ).toThrow(/outside the 10-30 budget/);
        });
    });

    test("never modifies an existing release (whole-tree byte identity); tombstones persist into vN+1", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string, tombstones?: string[], corpus = scenarios): { releaseDir: string } =>
                promoteRelease({
                    scenarios: corpus,
                    approvals: approvalsFor(corpus),
                    releasesRoot: root,
                    releaseVersion: version,
                    tombstones,
                });
            promote("v1");
            const v1Digest = treeDigest(join(root, "v1"));
            expect(() => promote("v1")).toThrow(/version already installed/);
            expect(treeDigest(join(root, "v1"))).toBe(v1Digest);

            // v2 tombstones a scenario: it must leave the corpus and its id
            // must persist in the manifest.
            const v2Corpus = corpusRaw().filter((raw) => raw.id !== "hse-scenario-0");
            const extra = validScenarioRaw();
            extra.id = "hse-scenario-replacement";
            v2Corpus.push(extra);
            promote("v2", ["hse-scenario-0"], v2Corpus);
            const v2 = loadRelease(join(root, "v2"));
            expect(v2.manifest.tombstones).toEqual(["hse-scenario-0"]);

            // v3 promoted with NO explicit tombstones still inherits v2's:
            // the success path of tombstone persistence (R12).
            promote("v3", [], v2Corpus);
            expect(loadRelease(join(root, "v3")).manifest.tombstones).toEqual(["hse-scenario-0"]);

            // A corpus resurrecting the tombstoned scenario is rejected.
            expect(() => promote("v4", [], corpusRaw())).toThrow(/tombstoned/);
            expect(treeDigest(join(root, "v1"))).toBe(v1Digest);
        });
    });

    test("rejects unexpected files inside a release dir on load", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            writeFileSync(join(releaseDir, "extra.txt"), "tamper\n");
            expect(() => loadRelease(releaseDir)).toThrow(/unexpected entries/);
        });
    });

    test("load fails closed on a corpus that no longer matches the manifest tuple", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const scenarioPath = join(releaseDir, RELEASE_FILES.scenariosDir, "hse-scenario-0.json");
            const edited = JSON.parse(readFileSync(scenarioPath, "utf8"));
            edited.title = "tampered";
            writeFileSync(scenarioPath, `${JSON.stringify(edited, null, 2)}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(/does not match the manifest release tuple/);
        });
    });

    test("load fails closed on forged or internally inconsistent evidence bytes", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const evidencePath = join(releaseDir, RELEASE_FILES.evidence);
            const readEvidence = (): Record<string, any> => JSON.parse(readFileSync(evidencePath, "utf8"));
            const writeEvidence = (value: unknown): void => {
                writeFileSync(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
            };
            const original = readFileSync(evidencePath, "utf8");

            // A hand-edited "green" shell with no per-result backing.
            const emptied = readEvidence();
            emptied.scenarios[0].results = [];
            writeEvidence(emptied);
            expect(() => loadRelease(releaseDir)).toThrow(/mutation evidence/);

            // A forged entry that keeps its aggregate booleans consistent but
            // never exercised a required class: one green result under a label
            // the battery only emits when it fails.
            writeFileSync(evidencePath, original);
            const forged = readEvidence();
            forged.scenarios[0].results = [
                { mutationClass: "battery-coverage", applicable: true, green: true, detail: "forged" },
            ];
            writeEvidence(forged);
            expect(() => loadRelease(releaseDir)).toThrow(/missing-class-/);

            // Dropping a single class from an otherwise complete green entry.
            writeFileSync(evidencePath, original);
            const dropped = readEvidence();
            dropped.scenarios[0].results = dropped.scenarios[0].results.filter(
                (result: { mutationClass: string }) => result.mutationClass !== "dropped-gold-fact",
            );
            writeEvidence(dropped);
            expect(() => loadRelease(releaseDir)).toThrow(/missing-class-dropped-gold-fact/);

            // A green entry in which neither false-authoritative class applied
            // means the family-to-class mapping drifted and nothing ran.
            writeFileSync(evidencePath, original);
            const inapplicable = readEvidence();
            for (const result of inapplicable.scenarios[0].results) {
                if (result.mutationClass === "speculation-promoted" || result.mutationClass === "rejected-proposal-active") {
                    result.applicable = false;
                }
            }
            writeEvidence(inapplicable);
            expect(() => loadRelease(releaseDir)).toThrow(/no-applicable-false-authoritative-class/);

            writeFileSync(evidencePath, original);
            expect(() => loadRelease(releaseDir)).not.toThrow();

            // A green entry that marks an unconditional class inapplicable
            // never exercised it.
            const inapplicableMandatory = readEvidence();
            for (const result of inapplicableMandatory.scenarios[0].results) {
                if (result.mutationClass === "dropped-gold-fact") result.applicable = false;
            }
            writeEvidence(inapplicableMandatory);
            expect(() => loadRelease(releaseDir)).toThrow(/inapplicable-class-dropped-gold-fact/);

            // An artifact whose own aggregate says the battery is red is not
            // loadable, however green its per-scenario entries are.
            writeFileSync(evidencePath, original);
            const globallyRed = readEvidence();
            globallyRed.scenarios.push({
                scenarioId: "hse-scenario-not-in-release",
                scenarioFingerprint: "a".repeat(64),
                green: false,
                results: [{ mutationClass: "battery-coverage", applicable: true, green: false, detail: "red" }],
            });
            globallyRed.green = false;
            writeEvidence(globallyRed);
            expect(() => loadRelease(releaseDir)).toThrow(/mutation-evidence: not-green/);

            // And an entry for a scenario outside the release is evidence
            // about something the release does not contain.
            writeFileSync(evidencePath, original);
            const extraGreen = readEvidence();
            extraGreen.scenarios.push({
                ...extraGreen.scenarios[0],
                scenarioId: "hse-scenario-not-in-release",
                scenarioFingerprint: "b".repeat(64),
            });
            writeEvidence(extraGreen);
            expect(() => loadRelease(releaseDir)).toThrow(/not-in-release/);

            writeFileSync(evidencePath, original);
            expect(() => loadRelease(releaseDir)).not.toThrow();
        });
    });

    test("the privacy gate scans approvals, not just scenarios", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            // `approver` is free-form and is published verbatim in
            // manifest.json, so it has to clear the same gate as the corpus.
            (approvals[0] as { approver: string }).approver = "operator-a (/home/operator/id_rsa)";
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/privacy\.[a-z-]+: approvals\[0\]/);
            expect(existsSync(join(root, "v1"))).toBe(false);

            // And the operator-supplied token list reaches approvals too.
            const tokenApprovals = approvalsFor(scenarios);
            (tokenApprovals[1] as { approver: string }).approver = "acme-internal-reviewer";
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: tokenApprovals,
                    releasesRoot: root,
                    releaseVersion: "v1",
                    forbiddenTokens: ["acme-internal"],
                }),
            ).toThrow(/privacy\.forbidden-token: approvals\[1\]/);
            expect(existsSync(join(root, "v1"))).toBe(false);
        });
    });

    test("promotion fails closed when a prior release directory has lost its manifest", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string, tombstones?: string[], corpus = scenarios): { releaseDir: string } =>
                promoteRelease({
                    scenarios: corpus,
                    approvals: approvalsFor(corpus),
                    releasesRoot: root,
                    releaseVersion: version,
                    tombstones,
                });
            // Swap the tombstoned scenario for a replacement so the corpus
            // stays inside the 10-30 release budget.
            const v2Corpus = corpusRaw().filter((raw) => raw.id !== "hse-scenario-0");
            const replacement = validScenarioRaw();
            replacement.id = "hse-scenario-replacement";
            v2Corpus.push(replacement);
            promote("v1");
            promote("v2", ["hse-scenario-0"], v2Corpus);

            // Atomic promotion never leaves a versioned directory without a
            // manifest, so one that exists is a partial or damaged release.
            // Skipping it would promote v3 without inheriting v2's tombstones
            // and let the rejected scenario back into the corpus.
            rmSync(join(root, "v2", RELEASE_FILES.manifest));
            expect(() => promote("v3", [], v2Corpus)).toThrow(/v2: manifest-missing/);
            expect(existsSync(join(root, "v3"))).toBe(false);
        });
    });
});
