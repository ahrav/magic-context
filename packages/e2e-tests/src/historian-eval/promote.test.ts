import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { buildReleaseTuple, parseScenario, releaseApprovalFingerprint } from "./contract";
import { RELEASE_FILES, loadRelease, promoteRelease, releaseArtifactFingerprint } from "./promote";
import { validScenarioRaw } from "./test-support";

function corpusRaw(count = 10): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => {
        const raw = validScenarioRaw();
        raw.id = `hse-scenario-${index}`;
        // The release tuple rejects duplicate SEMANTIC fingerprints, not just
        // duplicate ids: a scenario copied under a new name would silently
        // double-weight one evaluation in every aggregate. So each clone needs
        // distinct semantic content. Appending to the opening turn keeps the
        // gold and hard-negative spans (which the freeze lint requires to be
        // authored before the epilogue) intact.
        const turns = (raw.transcript as { turns: Array<{ user: string }> }).turns;
        turns[0].user = `${turns[0].user} Filed under ticket ${index}.`;
        return raw;
    });
}

/**
 * Approvals bound to the WHOLE release under review — version, tuple, and
 * tombstones — which is what `parseApproval`/`parseManifest` verify. The two
 * approvers must differ: one actor holding both seats collapses two reviews
 * into one judgement.
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
            stale[0].releaseFingerprint = "0".repeat(64);
            expect(() => promoteRelease({ ...base, approvals: stale })).toThrow(/stale-or-foreign-release/);
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
            // Append rather than replace: the original wording grounds the
            // scenario's hard-negative predicate, and dropping it would trip
            // the freeze lint before the approval binding is ever checked.
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
            // Still an authored span in the claim's source range, so the freeze
            // lint stays clean and the approval binding is what rejects.
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
            // `effective` is the tombstone set the manifest will actually carry
            // (inherited ∪ new), which is what approvals bind to — for v3 that
            // is v2's inherited id even though the caller passes none.
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
            // A skipped v1 would silently drop its tombstones from every
            // later release, re-admitting retracted scenarios.
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
            // Stands in for a deliberate privacy or sanitizer bump: v1's manifest
            // now carries a tuple this lane no longer implements. `parseManifest`
            // pins those constants, so re-certifying v1 while promoting v2 would
            // make it unparseable and block every later promotion — exactly when
            // its tombstones still have to be carried forward.
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
            // v1's tree copied under a numerically later name. Prior releases are
            // ordered by DIRECTORY, so v100 sorts newest while its manifest still
            // reports v1; succession would compare v2 against v1 and admit it,
            // leaving the immutable v100 numerically later than the release that
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
            // The fingerprint still matches the scenario's content, so a
            // fingerprint-only lookup accepts the entry — while every id-keyed
            // diagnostic, and the published artifact itself, now attributes this
            // scenario's mutation results to a different one.
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
            // Cloning a real entry keeps full class coverage and stays green, so
            // the per-entry parser and the artifact-level green flag both accept
            // it; only its identity is new. That is phantom mutation coverage the
            // artifact anchor would authenticate rather than contradict.
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
            // Publication and the caller's out-of-band recording are separate
            // stores, so a crash between them can leave v1 installed with no
            // anchor recorded. Re-promoting cannot recover it — the version is
            // occupied and releases are immutable — but the anchor is a pure
            // function of the published manifest and evidence, so it can be
            // recomputed from the installed tree.
            const reread = loadRelease(promoted.releaseDir);
            const recomputed = releaseArtifactFingerprint(reread.manifest, reread.mutationEvidence);
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
            // A hand-edited "green" shell with no per-result backing.
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

            // Duplicate member: JSON.parse keeps the LAST value while a human
            // reviewer reads the FIRST, and fingerprints are computed over
            // parsed values — only the canonical-byte check can catch this.
            const duplicated = original.replace(
                '"releaseVersion": "v1"',
                '"releaseVersion": "v9",\n  "releaseVersion": "v1"',
            );
            expect(duplicated).not.toBe(original);
            writeFileSync(manifestPath, duplicated);
            expect(() => loadRelease(releaseDir)).toThrow(/non-canonical-bytes/);

            // Re-serialized bytes (trailing whitespace) with identical parsed
            // values also reject: an installed release is byte-immutable.
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
            // Installing v1 after v2 would let a later tombstone-carrying
            // release sit BELOW an immutable release that still serves the
            // retired scenario, so the vN+1 errata rule could never retire it.
            expect(() => promote("v1")).toThrow(/not-later-than-previous/);
            expect(readdirSync(root)).toEqual(["v2"]);
            // Forward is still allowed.
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
            // A separately assembled or truncated release must not pass the
            // strict path with a corpus promotion would have rejected.
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
            // Entry names from an externally assembled tree never went through
            // the privacy scan, so they must not reach diagnostics or logs.
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
            // Bytes moved outside the installed vN directory: name-only checks
            // pass and every read follows the link, so what later runs load
            // could change without touching the "immutable" tree.
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

            // And the whole directory replaced by a link.
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
            // The untampered release matches its recorded anchor.
            expect(
                loadRelease(promoted.releaseDir, { expectedArtifactFingerprint: anchor }).manifest.releaseVersion,
            ).toBe("v1");

            // Rewrite only the approver: the release fingerprint the approvals
            // carry is unchanged, so every in-directory consistency check still
            // passes and the release loads as approved.
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
            // Every required class present, applicable, and green, with the
            // scenario fingerprints preserved: internally consistent evidence
            // for a battery that never ran. The parser cannot tell the
            // difference, so only the anchor can.
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
            // Scenario-id shaped, so the schema accepts it; the id is then
            // written verbatim into this and every later immutable manifest.
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
