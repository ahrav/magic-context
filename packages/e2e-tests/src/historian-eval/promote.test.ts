import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { HARD_NEGATIVE_FAMILIES, buildReleaseTuple, parseScenario, releaseApprovalFingerprint } from "./contract";
import { RELEASE_FILES, loadRelease, promoteRelease, releaseArtifactFingerprint } from "./promote";
import { validScenarioRaw } from "./test-support";

function corpusRaw(count = 10): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => {
        const raw = validScenarioRaw();
        raw.id = `hse-scenario-${index}`;
        // The release tuple rejects duplicate semantic fingerprints, not only duplicate IDs.
        // Duplicate semantic fingerprints would double-weight an evaluation in aggregates.
        // Appending to the opening turn preserves the authored spans before the epilogue.
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[0].user = `${turns[0].user} Filed under ticket ${index}.`;
        // Promotion requires every `HARD_NEGATIVE_FAMILIES` member to appear in the corpus.
        // The absent predicate retains the reference text so it remains before the epilogue and consistent with every gold claim.
        const family = HARD_NEGATIVE_FAMILIES[index % HARD_NEGATIVE_FAMILIES.length];
        raw.families = [family];
        const gold = raw.gold as { expectedAbsent: Array<Record<string, unknown>> };
        gold.expectedAbsent = gold.expectedAbsent.map((absent) => ({ ...absent, family }));
        return raw;
    });
}

/**
 * Approval fingerprints bind the release version, tuple, and tombstones.
 * approvers must differ: one actor holding both seats collapses two reviews
 */
function approvalsFor(
    scenariosRaw: Record<string, unknown>[],
    releaseVersion = "v1",
    tombstones: readonly string[] = [],
): Record<string, unknown>[] {
    const releaseTuple = buildReleaseTuple(scenariosRaw.map((raw) => parseScenario(raw)));
    const fingerprint = releaseApprovalFingerprint({ releaseVersion, releaseTuple, tombstones });
    return [
        { kind: "privacy", approver: "operator-a", releaseFingerprint: fingerprint },
        { kind: "gold-intent", approver: "operator-b", releaseFingerprint: fingerprint },
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

/* */
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
            stale[0].releaseFingerprint = "0".repeat(64);
            expect(() => promoteRelease({ ...base, approvals: stale })).toThrow(/stale-or-foreign-release/);
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
            // The test appends rather than replaces because the original wording grounds the hard-negative predicate.
            const turns = (scenarios[0].transcript as { turns: Array<{ user: string }> }).turns;
            turns[0].user = `${turns[0].user} Edited after approval.`;
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/stale-or-foreign-release/);
        });
    });

    test("gold edits after approval re-identify the scenario (gold is inside the fingerprint)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            // The span remains within the claim's source range, so freeze lint accepts it.
            (
                scenarios[0].gold as { expectedClaims: Array<{ predicate: { value: string } }> }
            ).expectedClaims[0].predicate.value = "in-process LRU";
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/stale-or-foreign-release/);
        });
    });

    test("refuses a corpus whose recomputed mutation battery is not green", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            // `y` remains a substring of `y-alt-`, exposing a non-discriminating matcher.
            // The test uses an unprobed extra claim so freeze lint does not reject a weakened probe-backed claim first.
            (
                scenarios[0].gold as {
                    expectedClaims: Array<Record<string, unknown>>;
                }
            ).expectedClaims.push({
                id: "exp-nondiscriminating",
                // The added predicate uses a unique category because containment is invalid within a category.
                // The validator rejects same-category predicates when one contains the other.
                category: "NAMING",
                predicate: { kind: "normalized-substring", value: "y" },
                sourceTurnRange: [1, 1],
            });
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
            // Predicate order determines matches when predicates overlap.
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

    test("privacy scan covers approvals: approver strings never reach the manifest unscanned", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const approvals = approvalsFor(scenarios);
            approvals[0].approver = "the key lives at /home/someone/secrets.pem";
            expect(() =>
                promoteRelease({ scenarios, approvals, releasesRoot: root, releaseVersion: "v1" }),
            ).toThrow(/privacy\./);

            // Word-bounded identifier deny list applies to approvers too.
            const clean = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios: clean,
                    approvals: approvalsFor(clean),
                    releasesRoot: root,
                    releaseVersion: "v1",
                    forbiddenIdentifiers: ["operator-a"],
                }),
            ).toThrow(/privacy\.forbidden-token/);
            expect(readdirSync(root)).toEqual([]);
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
            // Approvals bind `effective`, the union of inherited and new tombstones.
            // `effective` includes v2's inherited tombstone ID for v3 even when the caller supplies none.
            const promote = (
                version: string,
                tombstones: string[] = [],
                corpus = scenarios,
                effective: string[] = tombstones,
            ): { releaseDir: string } =>
                promoteRelease({
                    scenarios: corpus,
                    approvals: approvalsFor(corpus, version, effective),
                    releasesRoot: root,
                    releaseVersion: version,
                    tombstones,
                });
            promote("v1");
            const v1Digest = treeDigest(join(root, "v1"));
            expect(() => promote("v1")).toThrow(/version already installed/);
            expect(treeDigest(join(root, "v1"))).toBe(v1Digest);

            // The v2 corpus omits the tombstoned scenario and retains its ID.
            // The tombstoned scenario's ID must persist in the manifest.
            const v2Corpus = corpusRaw().filter((raw) => raw.id !== "hse-scenario-0");
            const extra = validScenarioRaw();
            extra.id = "hse-scenario-replacement";
            v2Corpus.push(extra);
            promote("v2", ["hse-scenario-0"], v2Corpus);
            const v2 = loadRelease(join(root, "v2"));
            expect(v2.manifest.tombstones).toEqual(["hse-scenario-0"]);

            // v3 inherits v2's tombstones when the caller supplies no explicit tombstones.
            promote("v3", [], v2Corpus, ["hse-scenario-0"]);
            expect(loadRelease(join(root, "v3")).manifest.tombstones).toEqual(["hse-scenario-0"]);

            // A corpus resurrecting the tombstoned scenario is rejected.
            expect(() => promote("v4", [], corpusRaw(), ["hse-scenario-0"])).toThrow(/tombstoned/);
            expect(treeDigest(join(root, "v1"))).toBe(v1Digest);
        });
    });

    test("tombstone inheritance fails closed on a prior release with no readable manifest (R12)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string): { releaseDir: string } =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: version,
                });
            promote("v1");
            rmSync(join(root, "v1", RELEASE_FILES.manifest));
            // Skipping v1 would drop its tombstones from later releases and re-admit retracted scenarios.
            expect(() => promote("v2")).toThrow(/no readable manifest/);
        });
    });

    test("prior releases are read as lineage, so a policy-constant rotation cannot block promotion (R12)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios, "v1", ["hse-retired"]),
                releasesRoot: root,
                releaseVersion: "v1",
                tombstones: ["hse-retired"],
            });
            // v1's manifest contains a release tuple unsupported by the current parser.
            // `parseManifest` rejects release tuples unsupported by the current parser.
            // `parseManifest` rejects v1's obsolete tuple, so v1 cannot be re-certified while later releases must inherit its tombstones.
            const manifestPath = join(root, "v1", RELEASE_FILES.manifest);
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                releaseTuple: { privacyPolicyVersion: string };
            };
            manifest.releaseTuple.privacyPolicyVersion = "rotated-after-v1";
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

            const next = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios: next,
                approvals: approvalsFor(next, "v2", ["hse-retired"]),
                releasesRoot: root,
                releaseVersion: "v2",
            });
            expect(loadRelease(releaseDir).manifest.tombstones).toEqual(["hse-retired"]);
        });
    });

    test("a prior manifest whose version does not match its directory is rejected", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // Prior releases are ordered by directory name, so a copied v1 tree named `v100` sorts newest despite its v1 manifest.
            // The succession check would compare v2 with manifest version v1 and admit v2.
            // Admitting v2 would leave immutable v100 numerically later than v2, the release that supersedes it.
            // supersedes it.
            cpSync(join(root, "v1"), join(root, "v100"), { recursive: true });
            const next = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios: next,
                    approvals: approvalsFor(next, "v2"),
                    releasesRoot: root,
                    releaseVersion: "v2",
                }),
            ).toThrow(/prior release v100 declares version v1/);
        });
    });

    test("load rejects mutation evidence filed under the wrong scenario id", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const evidencePath = join(releaseDir, RELEASE_FILES.evidence);
            const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
                scenarios: Array<{ scenarioId: string }>;
            };
            // A fingerprint-only lookup would accept the entry because its fingerprint still matches the scenario content.
            // Every ID-keyed diagnostic and the published artifact would attribute the mutation results to a different scenario.
            evidence.scenarios[0].scenarioId = "hse-mislabeled";
            writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(/scenario-id-mismatch/);
        });
    });

    test("load rejects mutation evidence carrying entries for scenarios outside the release", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const evidencePath = join(releaseDir, RELEASE_FILES.evidence);
            const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
                scenarios: Array<Record<string, unknown>>;
            };
            // A cloned real entry preserves full class coverage.
            // The per-entry parser accepts the cloned entry, and the artifact-level green flag remains true.
            // The cloned entry has a new identity, creating phantom mutation coverage.
            evidence.scenarios.push({
                ...evidence.scenarios[0],
                scenarioId: "hse-phantom",
                scenarioFingerprint: "f".repeat(64),
            });
            writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(/1 of 11 entries not in the corpus/);
        });
    });

    test("the artifact anchor is recomputable from the published tree, so a lost anchor is recoverable", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promoted = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // A crash between publication and out-of-band anchor recording can leave v1 installed without a recorded anchor.
            // Re-promotion cannot recover a missing anchor because releases are immutable.
            const reread = loadRelease(promoted.releaseDir);
            const recomputed = releaseArtifactFingerprint(reread.manifest, reread.mutationEvidence, reread.scenarios);
            expect(recomputed).toBe(promoted.artifactFingerprint);
            expect(
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: recomputed }).manifest.releaseVersion,
            ).toBe("v1");
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: "v1",
                }),
            ).toThrow(/version already installed/);
        });
    });

    test("load rejects a symlinked release directory", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // Replacing the release directory with a symlink makes child checks inspect an external tree.
            // The loader must reject a symlinked release directory because its target remains mutable outside releasesRoot.
            const outside = join(root, "release-elsewhere");
            renameSync(releaseDir, outside);
            symlinkSync(outside, releaseDir);
            expect(() => loadRelease(releaseDir)).toThrow(/release: not-a-real-directory/);
        });
    });

    test("the artifact anchor binds harness-owned trigger pressure the release tuple excludes", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promoted = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const scenarioPath = join(promoted.releaseDir, RELEASE_FILES.scenariosDir, "hse-scenario-0.json");
            const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
                trigger: { ballastTokensPerTurn: number };
            };
            // Changing trigger pressure leaves scenarioFingerprint unchanged.
            // scenarioFingerprint excludes trigger pressure, leaving the manifest tuple and mutation evidence unchanged.
            scenario.trigger.ballastTokensPerTurn += 100;
            writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`);

            // In-directory checks do not detect edits to trigger pressure.
            expect(loadRelease(promoted.releaseDir).manifest.releaseVersion).toBe("v1");
            // Only the external artifact anchor detects the changed trigger pressure.
            // Without the external artifact anchor, the same release label can execute different historian schedules.
            expect(() =>
                loadRelease(promoted.releaseDir, {
                    expectedArtifactFingerprint: promoted.artifactFingerprint,
                }),
            ).toThrow(/artifact fingerprint does not match/);
        });
    });

    test("load applies operator deny lists to the release before any parser runs", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // Strict loading must apply the current tombstone lists because promotion used earlier tombstone lists.
            // Strict loading must apply tombstone lists added after promotion.
            // Strict loading must also validate externally assembled releases that bypass promotion.
            expect(() => loadRelease(releaseDir)).not.toThrow();
            expect(() => loadRelease(releaseDir, { forbiddenTokens: ["Filed under ticket"] })).toThrow(/^privacy\./);
            expect(() => loadRelease(releaseDir, { forbiddenIdentifiers: ["operator-a"] })).toThrow(/^privacy\./);
            // A tombstone list that matches no release scenario leaves the release loadable.
            expect(() =>
                loadRelease(releaseDir, { forbiddenTokens: ["absent-codename"], forbiddenIdentifiers: ["nobody"] }),
            ).not.toThrow();
        });
    });

    test("the artifact anchor is order-independent, so promotion and read-back agree", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            // Prefix-related IDs can sort differently by filename and by ID.
            // `-` sorts before the `.` in `.json`, so filename order can differ from ID order.
            // `hse-alpha-beta.json` sorts before `hse-alpha.json`, while `hse-alpha` sorts before `hse-alpha-beta` as an ID.
            // The test passes the scenarios in reverse order to distinguish caller order from both filename and ID order.
            scenarios[0].id = "hse-alpha-beta";
            scenarios[1].id = "hse-alpha";
            const shuffled = [...scenarios].reverse();
            const promoted = promoteRelease({
                scenarios: shuffled,
                approvals: approvalsFor(shuffled),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // Promotion must return the fingerprint that consumers recompute, or authenticated loading rejects a valid release.
            const reread = loadRelease(promoted.releaseDir);
            expect(releaseArtifactFingerprint(reread.manifest, reread.mutationEvidence, reread.scenarios)).toBe(
                promoted.artifactFingerprint,
            );
            expect(
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: promoted.artifactFingerprint }).manifest
                    .releaseVersion,
            ).toBe("v1");
        });
    });

    test("prior release lineage rejects a symlinked release directory or manifest", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string): unknown =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios, version, ["hse-retired"]),
                    releasesRoot: root,
                    releaseVersion: version,
                    tombstones: ["hse-retired"],
                });
            promote("v1");
            const next = corpusRaw();
            const promoteV2 = (): unknown =>
                promoteRelease({
                    scenarios: next,
                    approvals: approvalsFor(next, "v2", ["hse-retired"]),
                    releasesRoot: root,
                    releaseVersion: "v2",
                });

            // `promoteRelease` must validate prior release directories as `loadRelease` does.
            // A symlinked release can expose a mutable external tombstone list.
            // Removing an ID from the external tombstone list re-admits a retired scenario.
            // The symlink target lies outside releasesRoot, where its tombstone list remains mutable.
            const outsideDir = join(root, "v1-elsewhere");
            renameSync(join(root, "v1"), outsideDir);
            symlinkSync(outsideDir, join(root, "v1"));
            expect(promoteV2).toThrow(/release\.v1: not-a-real-directory/);

            rmSync(join(root, "v1"));
            renameSync(outsideDir, join(root, "v1"));
            const manifestPath = join(root, "v1", RELEASE_FILES.manifest);
            const outsideManifest = join(root, "manifest-elsewhere.json");
            renameSync(manifestPath, outsideManifest);
            symlinkSync(outsideManifest, manifestPath);
            expect(promoteV2).toThrow(/release\.v1\.manifest: not-a-regular-file/);
        });
    });

    test("refuses a corpus that omits hard-negative families, however clean each scenario is", () => {
        withRoot((root) => {
            const single = HARD_NEGATIVE_FAMILIES[0];
            const scenarios = corpusRaw().map((raw) => {
                raw.families = [single];
                const gold = raw.gold as { expectedAbsent: Array<Record<string, unknown>> };
                gold.expectedAbsent = gold.expectedAbsent.map((absent) => ({ ...absent, family: single }));
                return raw;
            });
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: "v1",
                }),
            ).toThrow(/release\.families: missing-/);
        });
    });

    test("strict loading rejects a noncanonical release version the promoter would refuse", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // check works.
            const manifestPath = join(releaseDir, RELEASE_FILES.manifest);
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                releaseVersion: string;
                releaseTuple: Parameters<typeof releaseApprovalFingerprint>[0]["releaseTuple"];
                tombstones: string[];
                approvals: { privacy: { releaseFingerprint: string }; goldIntent: { releaseFingerprint: string } };
            };
            manifest.releaseVersion = "v01";
            const rebound = releaseApprovalFingerprint({
                releaseVersion: "v01",
                releaseTuple: manifest.releaseTuple,
                tombstones: manifest.tombstones,
            });
            manifest.approvals.privacy.releaseFingerprint = rebound;
            manifest.approvals.goldIntent.releaseFingerprint = rebound;
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(
                /release\.manifest\.releaseVersion: version-not-canonical/,
            );
        });
    });

    test("strict loading rejects a manifest whose version is not the directory it is installed as", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const copy = join(root, "v2");
            cpSync(releaseDir, copy, { recursive: true });
            expect(() => loadRelease(copy)).toThrow(
                /release\.manifest\.releaseVersion: declares v1 in directory v2/,
            );
            for (const spelling of [join(copy, "."), `${copy}/`, join(copy, "..", "v2")]) {
                expect(() => loadRelease(spelling)).toThrow(
                    /release\.manifest\.releaseVersion: declares v1 in directory v2/,
                );
            }
            expect(loadRelease(releaseDir).manifest.releaseVersion).toBe("v1");
        });
    });

    test("a noncanonical prior release directory is rejected before its lineage is inherited", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            cpSync(join(root, "v1"), join(root, "v01"), { recursive: true });
            const next = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios: next,
                    approvals: approvalsFor(next, "v2"),
                    releasesRoot: root,
                    releaseVersion: "v2",
                }),
            ).toThrow(/release\.v01: version-not-canonical/);
        });
    });

    test("promotion is serialized per releases root and releases its lock", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string): { releaseDir: string } =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios, version),
                    releasesRoot: root,
                    releaseVersion: version,
                });
            // in-flight candidate.
            mkdirSync(root, { recursive: true });
            const lockPath = join(root, ".promote.lock");
            writeFileSync(lockPath, "pid 999999\n");
            expect(() => promote("v1")).toThrow(/another promotion holds \.promote\.lock/);

            rmSync(lockPath);
            promote("v1");
            expect(existsSync(lockPath)).toBe(false);
            expect(existsSync(join(root, "v1"))).toBe(true);
        });
    });

    test("interrupted promotions never accumulate: stale staging trees are swept before publishing", () => {
        withRoot((root) => {
            const stale = join(root, ".staging-interrupted");
            mkdirSync(stale, { recursive: true });
            writeFileSync(join(stale, "manifest.json"), "{}\n");
            const scenarios = corpusRaw();
            promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            expect(readdirSync(root)).toEqual(["v1"]);
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
            const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
            evidence.scenarios[0].results = [];
            writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(/mutation evidence/);
        });
    });

    test("load fails closed on byte-level tampering the parsed values would hide", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const manifestPath = join(releaseDir, RELEASE_FILES.manifest);
            const original = readFileSync(manifestPath, "utf8");

            const duplicated = original.replace(
                '"releaseVersion": "v1"',
                '"releaseVersion": "v9",\n  "releaseVersion": "v1"',
            );
            expect(duplicated).not.toBe(original);
            writeFileSync(manifestPath, duplicated);
            expect(() => loadRelease(releaseDir)).toThrow(/non-canonical-bytes/);

            writeFileSync(manifestPath, `${original}\n`);
            expect(() => loadRelease(releaseDir)).toThrow(/non-canonical-bytes/);
        });
    });

    test("promotion only moves forward: an earlier version is rejected even when unoccupied", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promote = (version: string): unknown =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios, version),
                    releasesRoot: root,
                    releaseVersion: version,
                });
            promote("v2");
            expect(() => promote("v1")).toThrow(/not-later-than-previous/);
            expect(readdirSync(root)).toEqual(["v2"]);
            promote("v3");
            expect(readdirSync(root).sort()).toEqual(["v2", "v3"]);
        });
    });

    test("non-canonical version strings reject (v01 and v1 would share an ordinal)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: "v01",
                }),
            ).toThrow(/version-not-canonical/);
            expect(readdirSync(root)).toEqual([]);
        });
    });

    test("load enforces the corpus-size budget promotion enforces (R1)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            rmSync(join(releaseDir, RELEASE_FILES.scenariosDir, "hse-scenario-0.json"));
            expect(() => loadRelease(releaseDir)).toThrow(/outside the 10-30 budget/);
        });
    });

    test("load reports only the COUNT of unexpected entries, never their unscanned names", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const secret = "ghp-deadbeefsecrettoken.txt";
            writeFileSync(join(releaseDir, secret), "tamper\n");
            let message = "";
            try {
                loadRelease(releaseDir);
            } catch (error) {
                message = (error as Error).message;
            }
            expect(message).toMatch(/unexpected entries/);
            expect(message).not.toContain(secret);
            expect(message).not.toContain("deadbeef");
        });
    });

    test("load rejects symlinked release artifacts (a frozen tree must be real files)", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            // Symlink targets outside the installed directory can change without modifying the installed tree.
            const manifestPath = join(releaseDir, RELEASE_FILES.manifest);
            const outside = join(root, "manifest-elsewhere.json");
            renameSync(manifestPath, outside);
            symlinkSync(outside, manifestPath);
            expect(() => loadRelease(releaseDir)).toThrow(/release\.manifest: not-a-regular-file/);
        });
    });

    test("load rejects a symlinked scenario file and a symlinked scenarios directory", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const { releaseDir } = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const scenarioPath = join(releaseDir, RELEASE_FILES.scenariosDir, "hse-scenario-0.json");
            const outside = join(root, "scenario-elsewhere.json");
            renameSync(scenarioPath, outside);
            symlinkSync(outside, scenarioPath);
            expect(() => loadRelease(releaseDir)).toThrow(/not-a-regular-file/);

            const dirPath = join(releaseDir, RELEASE_FILES.scenariosDir);
            const outsideDir = join(root, "scenarios-elsewhere");
            renameSync(dirPath, outsideDir);
            symlinkSync(outsideDir, dirPath);
            expect(() => loadRelease(releaseDir)).toThrow(/not-a-real-directory/);
        });
    });

    test("an out-of-band artifact fingerprint detects edits the tree cannot self-detect", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promoted = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const anchor = promoted.artifactFingerprint;
            expect(anchor).toMatch(/^[0-9a-f]{64}$/);
            expect(
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: anchor }).manifest.releaseVersion,
            ).toBe("v1");

            const manifestPath = join(promoted.releaseDir, RELEASE_FILES.manifest);
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            manifest.approvals.privacy.approver = "attacker";
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            expect(loadRelease(promoted.releaseDir).manifest.approvals.privacy.approver).toBe("attacker");
            expect(() =>
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: anchor }),
            ).toThrow(/artifact fingerprint does not match/);
        });
    });

    test("the artifact anchor also covers the separately mutable evidence file", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promoted = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const evidencePath = join(promoted.releaseDir, RELEASE_FILES.evidence);
            const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
            for (const entry of evidence.scenarios) {
                entry.results = entry.results.map((result: { mutationClass: string }) => ({
                    mutationClass: result.mutationClass,
                    applicable: true,
                    green: true,
                    detail: "fabricated",
                }));
            }
            writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
            expect(() => loadRelease(promoted.releaseDir)).not.toThrow();
            expect(() =>
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: promoted.artifactFingerprint }),
            ).toThrow(/artifact fingerprint does not match/);
        });
    });

    test("a tombstone carrying a denied token is refused before publication", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            expect(() =>
                promoteRelease({
                    scenarios,
                    approvals: approvalsFor(scenarios, "v1", ["hse-customer-acme"]),
                    releasesRoot: root,
                    releaseVersion: "v1",
                    tombstones: ["hse-customer-acme"],
                    forbiddenTokens: ["acme"],
                }),
            ).toThrow(/privacy\./);
            expect(readdirSync(root)).toEqual([]);
        });
    });
});
