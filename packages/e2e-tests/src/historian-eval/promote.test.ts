import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { buildReleaseTuple, parseScenario } from "./contract";
import { RELEASE_FILES, loadRelease, promoteRelease } from "./promote";
import { validScenarioRaw } from "./test-support";

function corpusRaw(count = 10): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) => {
        const raw = validScenarioRaw();
        raw.id = `hse-scenario-${index}`;
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
            // Append rather than replace: the original wording grounds the
            // scenario's hard-negative predicate, and dropping it would trip
            // the freeze lint before the approval binding is ever checked.
            const turns = (scenarios[0].transcript as { turns: Array<{ user: string }> }).turns;
            turns[0].user = `${turns[0].user} Edited after approval.`;
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
                    approvals: approvalsFor(scenarios),
                    releasesRoot: root,
                    releaseVersion: version,
                });
            promote("v2");
            // Installing v1 after v2 would let a later tombstone-carrying
            // release sit BELOW an immutable release that still serves the
            // retired scenario, so the vN+1 errata rule could never retire it.
            expect(() => promote("v1")).toThrow(/not later than the installed v2/);
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

    test("an out-of-band manifest fingerprint detects an edited approver the tree cannot self-detect", () => {
        withRoot((root) => {
            const scenarios = corpusRaw();
            const promoted = promoteRelease({
                scenarios,
                approvals: approvalsFor(scenarios),
                releasesRoot: root,
                releaseVersion: "v1",
            });
            const anchor = promoted.manifestFingerprint;
            expect(anchor).toMatch(/^[0-9a-f]{64}$/);
            // The untampered release matches its recorded anchor.
            expect(
                loadRelease(promoted.releaseDir, { expectedManifestFingerprint: anchor }).manifest.releaseVersion,
            ).toBe("v1");

            // Rewrite only the approver: the tuple fingerprint the approvals
            // carry is unchanged, so every in-directory consistency check
            // still passes and the release loads as approved.
            const manifestPath = join(promoted.releaseDir, RELEASE_FILES.manifest);
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            manifest.approvals.privacy.approver = "attacker";
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            expect(loadRelease(promoted.releaseDir).manifest.approvals.privacy.approver).toBe("attacker");

            // Only the external anchor catches it.
            expect(() =>
                loadRelease(promoted.releaseDir, { expectedManifestFingerprint: anchor }),
            ).toThrow(/does not match the expected trust anchor/);
        });
    });
});
