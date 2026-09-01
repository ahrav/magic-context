/**
 *
 * Existing releases are immutable; later releases carry errata as tombstones.
 */

import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { canonicalFingerprint, readCanonicalJsonFile } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { hasGitAncestor } from "../../../plugin/scripts/retrieval-benchmark/fs-boundary";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    APPROVAL_KINDS,
    HARD_NEGATIVE_FAMILIES,
    HistorianEvalContractError,
    MANIFEST_SCHEMA,
    RELEASE_VERSION_RE,
    assertReleaseSuccession,
    buildReleaseTuple,
    lintScenario,
    parseApproval,
    parseManifest,
    parseReleaseLineage,
    parseScenario,
    releaseApprovalFingerprint,
    scenarioFingerprint,
    type Approval,
    type ApprovalKind,
    type HistorianEvalScenario,
    type ReleaseLineage,
    type ReleaseManifest,
} from "./contract";
import { parseMutationEvidence, runMutationBattery, type MutationEvidenceArtifact } from "./mutations";

export const RELEASE_FILES = {
    manifest: "manifest.json",
    evidence: "mutation-evidence.json",
    scenariosDir: "scenarios",
} as const;

/** Promotion and loading enforce the same 10–30 scenario budget. */
export const CORPUS_SIZE_BUDGET = { min: 10, max: 30 } as const;

export interface PromotionInput {
    /** Raw scenario documents (unparsed: the privacy gate runs first). */
    scenarios: readonly unknown[];
    /** Operator-supplied approvals, exactly one per kind. Never minted here. */
    approvals: readonly unknown[];
    releasesRoot: string;
    releaseVersion: string;
    /** Carries forward prior-release errata and adds new tombstones. */
    tombstones?: readonly string[];
    forbiddenTokens?: readonly string[];
    /** Word-bounded username/identifier deny list, forwarded to the privacy scan. */
    forbiddenIdentifiers?: readonly string[];
}

function fail(diagnostics: string[]): never {
    throw new HistorianEvalContractError(diagnostics);
}

/**
 * Canonical-byte verification rejects duplicate members and non-canonical encodings before fingerprint checks.
 * produce.
 */
function readReleaseJson(path: string, label: string): unknown {
    return readCanonicalJsonFile(path, (code) => new HistorianEvalContractError([`${label}: ${code}`]));
}

function checkApprovals(rawApprovals: readonly unknown[], releaseFingerprint: string): { privacy: Approval; goldIntent: Approval } {
    const approvals = rawApprovals.map((raw, index) => parseApproval(raw, `approvals[${index}]`));
    const byKind = new Map<ApprovalKind, Approval>();
    const diagnostics: string[] = [];
    for (const approval of approvals) {
        if (byKind.has(approval.kind)) diagnostics.push(`approvals.${approval.kind}: duplicate-kind`);
        byKind.set(approval.kind, approval);
        // Approvals bind the release version, tuple, and tombstones to prevent replay against a different release.
        // a tombstone.
        if (approval.releaseFingerprint !== releaseFingerprint) {
            diagnostics.push(`approvals.${approval.kind}: stale-or-foreign-release`);
        }
    }
    for (const kind of APPROVAL_KINDS) {
        if (!byKind.has(kind)) diagnostics.push(`approvals.${kind}: missing`);
    }
    if (diagnostics.length > 0) fail(diagnostics);
    return { privacy: byKind.get("privacy") as Approval, goldIntent: byKind.get("gold-intent") as Approval };
}

/**
 * Mutation evidence must contain exactly one entry for every corpus scenario, keyed by that scenario's ID.
 *
 * Evidence IDs must match corpus IDs because scenario fingerprints do not bind entries to IDs, and extra entries would authenticate non-release coverage.
 */
function checkMutationEvidence(
    evidence: MutationEvidenceArtifact,
    scenarios: readonly HistorianEvalScenario[],
): void {
    const diagnostics: string[] = [];
    const byFingerprint = new Map(evidence.scenarios.map((entry) => [entry.scenarioFingerprint, entry]));
    const matched = new Set<string>();
    for (const scenario of scenarios) {
        const fingerprint = scenarioFingerprint(scenario);
        const entry = byFingerprint.get(fingerprint);
        if (entry === undefined) {
            diagnostics.push(`mutation-evidence.${scenario.id}: missing`);
            continue;
        }
        matched.add(fingerprint);
        if (entry.scenarioId !== scenario.id) {
            diagnostics.push(`mutation-evidence.${scenario.id}: scenario-id-mismatch`);
        }
        if (!entry.green) diagnostics.push(`mutation-evidence.${scenario.id}: not-green`);
    }
    // Unmatched entries' `scenarioId` values need only be non-empty strings, so diagnostics report their count instead of unreviewed IDs.
    const unrepresented = evidence.scenarios.filter((entry) => !matched.has(entry.scenarioFingerprint)).length;
    if (unrepresented > 0) {
        diagnostics.push(`mutation-evidence: ${unrepresented} of ${evidence.scenarios.length} entries not in the corpus`);
    }
    if (diagnostics.length > 0) fail(diagnostics);
}

/**
 * Operators must supply this out-of-band fingerprint to `loadRelease`; release-directory contents cannot authenticate themselves.
 * Without an external fingerprint, an editor can rewrite `approver` or fabricate green evidence while passing in-directory checks.
 * in-directory check.
 *
 * The anchor includes all independently mutable artifacts; internal consistency does not prove mutations ran.
 *
 * `releaseArtifactFingerprint` hashes scenarios directly because `releaseTuple` omits trigger pressure.
 * `scenarioFingerprint` excludes trigger pressure so approvals remain trigger-independent.
 * `releaseArtifactFingerprint` hashes trigger-pressure fields because changing them changes historian schedules without changing `releaseTuple`.
 * `modelContextLimit`, per-turn usage, and spike usage determine when the historian fires.
 * `releaseApprovalFingerprint` remains trigger-independent and covers the version, tuple, and tombstones.
 *
 * `releaseArtifactFingerprint` sorts scenarios by ID because promotion and `loadRelease` supply different noncanonical orders.
 * Scenario IDs must be unique so sorting by id defines a total order.
 */
export function releaseArtifactFingerprint(
    manifest: ReleaseManifest,
    evidence: MutationEvidenceArtifact,
    scenarios: readonly HistorianEvalScenario[],
): string {
    const ordered = [...scenarios].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return canonicalFingerprint({ manifest, mutationEvidence: evidence, scenarios: ordered });
}

/**
 * Declared hard-negative families must cover every `HARD_NEGATIVE_FAMILIES` member.
 *
 * Per-scenario lint verifies only each scenario's declared families.
 * A lint-clean corpus can declare only one family.
 * A release can omit user-correction, current-vs-historical, and prompt-injection coverage despite green mutation evidence.
 * Missing-family names come from `HARD_NEGATIVE_FAMILIES`, not corpus artifacts.
 *
 * `--lint` and freeze promotion call `checkFamilyCoverage` to enforce one family-coverage rule.
 */
export function checkFamilyCoverage(scenarios: readonly HistorianEvalScenario[]): string[] {
    const declared = new Set(scenarios.flatMap((scenario) => scenario.families));
    const missing = HARD_NEGATIVE_FAMILIES.filter((family) => !declared.has(family));
    return missing.length > 0 ? [`release.families: missing-${missing.join(",")}`] : [];
}

/** `assertRegularFile` rejects all symlinks. */
function assertRegularFile(path: string, label: string): void {
    if (!lstatSync(path).isFile()) fail([`${label}: not-a-regular-file`]);
}

/**
 * `assertCanonicalVersion` rejects noncanonical spellings such as `v01`, which share `v1`'s ordinal.
 */
function assertCanonicalVersion(version: string, label: string): void {
    if (!RELEASE_VERSION_RE.test(version) || version !== `v${versionOrdinal(version)}`) {
        fail([`${label}: version-not-canonical`]);
    }
}

/** `assertRealDirectory` rejects all symlinks. */
function assertRealDirectory(path: string, label: string): void {
    if (!lstatSync(path).isDirectory()) fail([`${label}: not-a-real-directory`]);
}

export interface LoadReleaseOptions {
    /**
     * `expectedArtifactFingerprint` must come from a trust anchor outside the release directory.
     * Callers may omit `expectedArtifactFingerprint` only when they already trust the release tree.
     */
    expectedArtifactFingerprint?: string;
    /**
     * `forbiddenTokens` and `forbiddenIdentifiers` are the promotion privacy deny lists.
     * Privacy scanning is required for releases assembled outside the promoter.
     * Omitting both means no scan, matching a caller that already trusts the tree.
     */
    forbiddenTokens?: readonly string[];
    forbiddenIdentifiers?: readonly string[];
}

/**
 * evidence.
 *
 * The privacy scan runs on unparsed values because parser diagnostics interpolate scenario IDs and field paths.
 */
export function loadRelease(
    releaseDir: string,
    options: LoadReleaseOptions = {},
): {
    manifest: ReleaseManifest;
    scenarios: HistorianEvalScenario[];
    mutationEvidence: MutationEvidenceArtifact;
} {
    // Child checks would see an ordinary tree after resolving a releaseDir symlink.
    // A `vN` symlink outside `releasesRoot` could pass the version-directory check.
    // Such a symlink would leave release bytes mutable outside the releases root.
    // immutable release.
    assertRealDirectory(releaseDir, "release");
    const entries = readdirSync(releaseDir).sort();
    const expected: string[] = [RELEASE_FILES.evidence, RELEASE_FILES.manifest, RELEASE_FILES.scenariosDir];
    const unexpected = entries.filter((entry) => !expected.includes(entry));
    if (unexpected.length > 0 || entries.length !== expected.length) {
        // `loadRelease` reports entry counts because entry names have not passed the privacy scan.
        // Reporting filenames could expose unscanned sensitive content in logs.
        fail([
            `release: unexpected entries (${unexpected.length} unexpected of ${entries.length}, expected ${expected.length})`,
        ]);
    }
    // `loadRelease` rejects symlinks because name checks accept them and later reads follow them.
    // Later reads follow symlinks, so a self-consistent link farm would pass `loadRelease`.
    assertRegularFile(join(releaseDir, RELEASE_FILES.manifest), "release.manifest");
    assertRegularFile(join(releaseDir, RELEASE_FILES.evidence), "release.mutation-evidence");
    const scenariosDir = join(releaseDir, RELEASE_FILES.scenariosDir);
    assertRealDirectory(scenariosDir, "release.scenarios");

    const scenarioFiles = readdirSync(scenariosDir).sort();
    // `loadRelease` uses index-based labels so parser diagnostics cannot echo unscanned filenames.
    // `parseScenario` includes its label in every validation diagnostic.
    // A filename used as a label could expose unscanned content in diagnostics.
    // The index is enough to locate the file, since the list is sorted.
    for (const [index, file] of scenarioFiles.entries()) {
        assertRegularFile(join(scenariosDir, file), `release.scenarios[${index}]`);
    }
    // `loadRelease` enforces `CORPUS_SIZE_BUDGET` to match promotion's corpus-size limit.
    if (scenarioFiles.length < CORPUS_SIZE_BUDGET.min || scenarioFiles.length > CORPUS_SIZE_BUDGET.max) {
        fail([
            `release: corpus size ${scenarioFiles.length} outside the ${CORPUS_SIZE_BUDGET.min}-${CORPUS_SIZE_BUDGET.max} budget (R1)`,
        ]);
    }

    const rawManifest = readReleaseJson(join(releaseDir, RELEASE_FILES.manifest), "release.manifest");
    const rawEvidence = readReleaseJson(join(releaseDir, RELEASE_FILES.evidence), "release.mutation-evidence");
    const rawScenarios = scenarioFiles.map((file, index) =>
        readReleaseJson(join(scenariosDir, file), `release.scenarios[${index}]`),
    );
    // constrains.
    if (options.forbiddenTokens !== undefined || options.forbiddenIdentifiers !== undefined) {
        const privacyDiagnostics = scanForSensitiveContent(
            { manifest: rawManifest, mutationEvidence: rawEvidence, scenarios: rawScenarios },
            {
                ...(options.forbiddenTokens === undefined ? {} : { forbiddenTokens: options.forbiddenTokens }),
                ...(options.forbiddenIdentifiers === undefined
                    ? {}
                    : { forbiddenIdentifiers: options.forbiddenIdentifiers }),
            },
        ).map((violation) => `privacy.${violation.category}: ${violation.path}`);
        if (privacyDiagnostics.length > 0) fail(privacyDiagnostics.sort());
    }

    const manifest = parseManifest(rawManifest);
    // The validator rejects noncanonical version strings that `parseManifest` accepts but `promoteRelease` refuses.
    // `parseManifest` accepts `v01` under `RELEASE_VERSION_RE`.
    // `promoteRelease` refuses to publish `v01`.
    assertCanonicalVersion(manifest.releaseVersion, "release.manifest.releaseVersion");
    // `manifest.releaseVersion` must equal a version-named `releaseDir` basename; otherwise a copied release can run a corpus under the wrong reported version.
    //
    // Labels that interpolate only `entry` cannot echo arbitrary artifact content because `RELEASE_VERSION_RE` bounds `entry`.
    //
    // `resolve` prevents `.` and `..` path components from bypassing the version-directory check.
    const installedAs = basename(resolve(releaseDir));
    if (RELEASE_VERSION_RE.test(installedAs) && manifest.releaseVersion !== installedAs) {
        fail([`release.manifest.releaseVersion: declares ${manifest.releaseVersion} in directory ${installedAs}`]);
    }
    const mutationEvidence = parseMutationEvidence(rawEvidence);
    const scenarios = rawScenarios.map((raw, index) => parseScenario(raw, `release.scenarios[${index}]`));
    // The fingerprint check runs after parsing so the anchor covers validated values.
    if (
        options.expectedArtifactFingerprint !== undefined &&
        releaseArtifactFingerprint(manifest, mutationEvidence, scenarios) !== options.expectedArtifactFingerprint
    ) {
        fail(["release: artifact fingerprint does not match the expected trust anchor"]);
    }
    const diagnostics: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
        if (scenarioFiles[index] !== `${scenario.id}.json`) {
            diagnostics.push(`release.scenarios[${index}]: filename-id-mismatch`);
        }
        const lint = lintScenario(scenario);
        if (lint.length > 0) diagnostics.push(...lint);
        if (manifest.tombstones.includes(scenario.id)) {
            diagnostics.push(`release.scenarios.${scenario.id}: tombstoned`);
        }
    }
    diagnostics.push(...checkFamilyCoverage(scenarios));
    if (diagnostics.length > 0) fail(diagnostics);
    const tuple = buildReleaseTuple(scenarios);
    if (canonicalFingerprint(tuple) !== canonicalFingerprint(manifest.releaseTuple)) {
        fail(["release: corpus does not match the manifest release tuple"]);
    }
    checkMutationEvidence(mutationEvidence, scenarios);
    return { manifest, scenarios, mutationEvidence };
}

function writeReleaseTree(dir: string, manifest: ReleaseManifest, scenarios: readonly HistorianEvalScenario[], evidence: MutationEvidenceArtifact): void {
    mkdirSync(join(dir, RELEASE_FILES.scenariosDir), { recursive: true });
    const write = (path: string, value: unknown): void => {
        writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    };
    write(join(dir, RELEASE_FILES.manifest), manifest);
    write(join(dir, RELEASE_FILES.evidence), evidence);
    for (const scenario of scenarios) {
        write(join(dir, RELEASE_FILES.scenariosDir, `${scenario.id}.json`), scenario);
    }
}

/* */
function versionOrdinal(version: string): number {
    return Number(version.slice(1));
}

/**
 * `installedReleases` returns installed releases in ascending version order.
 * The validator uses one ordered release list for tombstone inheritance and succession.
 *
 * The consumer uses each predecessor only to inherit its tombstones, not to recertify its manifest.
 *
 * The validator fails when a version-named directory lacks a loadable manifest; otherwise a retracted scenario could re-enter a later release.
 *
 * `installedReleases` trusts prior lineage as filesystem state and cannot verify that its files were approved.
 * Symlink guards keep manifest bytes inside `releasesRoot` but cannot prove that they were approved.
 * An in-place canonical rewrite can remove a tombstone despite the symlink guards.
 * A canonical manifest rewrite that removes a tombstone reduces the inherited tombstone set.
 * `parseManifest` re-certifies predecessors under the lane's policy versions.
 * Preventing canonical rewrites from dropping tombstones requires trusted prior state.
 * own manifest.
 */
function installedReleases(releasesRoot: string): ReleaseLineage[] {
    if (!existsSync(releasesRoot)) return [];
    return readdirSync(releasesRoot)
        .filter((entry) => RELEASE_VERSION_RE.test(entry))
        .sort((left, right) => versionOrdinal(left) - versionOrdinal(right))
        .map((entry) => {
            const manifestPath = join(releasesRoot, entry, RELEASE_FILES.manifest);
            if (!existsSync(manifestPath)) {
                fail([`release: prior release ${entry} has no readable manifest; refusing to inherit tombstones`]);
            }
            // `installedReleases` applies the consumer symlink checks because it bypasses `loadRelease`.
            assertCanonicalVersion(entry, `release.${entry}`);
            assertRealDirectory(join(releasesRoot, entry), `release.${entry}`);
            assertRegularFile(manifestPath, `release.${entry}.manifest`);
            const lineage = parseReleaseLineage(
                readReleaseJson(manifestPath, `release.${entry}.manifest`),
                `release.${entry}.manifest`,
            );
            // Directory ordering uses directory names, while succession uses manifest `releaseVersion`.
            // `lineage.releaseVersion` must equal the directory name so directory ordering cannot misorder succession.
            // content.
            if (lineage.releaseVersion !== entry) {
                fail([`release: prior release ${entry} declares version ${lineage.releaseVersion}`]);
            }
            return lineage;
        });
}

/** Prior releases' tombstones persist in every later release. */
function inheritedTombstones(prior: readonly ReleaseLineage[]): string[] {
    const tombstones = new Set<string>();
    for (const lineage of prior) {
        for (const id of lineage.tombstones) tombstones.add(id);
    }
    return [...tombstones].sort();
}

/** The promotion lock excludes other promoters for the same releases root. */
const PROMOTION_LOCK = ".promote.lock";

/**
 * The promotion lock serializes promotion from reading through publishing for each releases root.
 * releases root.
 *
 * The lineage snapshot must remain current until the publishing rename.
 * Concurrent promoters can validate the same predecessor and publish independently without the promotion lock.
 * A concurrent promoter can publish a tombstoned scenario after reading the predecessor before another promoter publishes the tombstone.
 * The staging sweep can delete another promoter's in-flight `.staging-*` candidate.
 *
 * Lock acquisition rejects an existing lock because a live owner cannot be distinguished from a stale lock.
 * The diagnostic names `.promote.lock` so an operator can remove a confirmed stale lock.
 * `wx` atomically creates the lock only when it does not exist.
 */
function withPromotionLock<T>(releasesRoot: string, run: () => T): T {
    mkdirSync(releasesRoot, { recursive: true });
    const lockPath = join(releasesRoot, PROMOTION_LOCK);
    try {
        writeFileSync(lockPath, `pid ${process.pid}\n`, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            fail([
                `release: another promotion holds ${PROMOTION_LOCK} for this releases root; remove it only after confirming no promoter is running`,
            ]);
        }
        throw error;
    }
    try {
        return run();
    } finally {
        rmSync(lockPath, { force: true });
    }
}

export function promoteRelease(input: PromotionInput): { releaseDir: string; artifactFingerprint: string } {
    if (!RELEASE_VERSION_RE.test(input.releaseVersion)) {
        fail(["release: version-invalid"]);
    }
    assertCanonicalVersion(input.releaseVersion, "release");

    // Promotion scans for sensitive content before parsing because parser diagnostics include scenario IDs and field paths.
    // Promotion scans approvals because approver strings are copied verbatim into the immutable manifest.
    // Promotion scans tombstones because later manifests carry their IDs forward.
    const privacyDiagnostics = scanForSensitiveContent(
        { scenarios: input.scenarios, approvals: input.approvals, tombstones: input.tombstones ?? [] },
        {
            forbiddenTokens: input.forbiddenTokens,
            forbiddenIdentifiers: input.forbiddenIdentifiers,
        },
    ).map((violation) => `privacy.${violation.category}: ${violation.path}`);
    if (privacyDiagnostics.length > 0) fail(privacyDiagnostics.sort());

    const scenarios = input.scenarios.map((raw, index) => parseScenario(raw, `scenarios[${index}]`));
    const lintDiagnostics = scenarios.flatMap((scenario) => lintScenario(scenario));
    if (lintDiagnostics.length > 0) fail(lintDiagnostics);
    const ids = new Set(scenarios.map((scenario) => scenario.id));
    if (ids.size !== scenarios.length) fail(["release: duplicate scenario ids"]);
    if (scenarios.length < CORPUS_SIZE_BUDGET.min || scenarios.length > CORPUS_SIZE_BUDGET.max) {
        fail([
            `release: corpus size ${scenarios.length} outside the ${CORPUS_SIZE_BUDGET.min}-${CORPUS_SIZE_BUDGET.max} budget (R1)`,
        ]);
    }
    const familyDiagnostics = checkFamilyCoverage(scenarios);
    if (familyDiagnostics.length > 0) fail(familyDiagnostics);

    // Promotion holds the lock from the lineage snapshot through the publishing rename.
    return withPromotionLock(input.releasesRoot, () => promoteUnderLock(input, scenarios, ids));
}

function promoteUnderLock(
    input: PromotionInput,
    scenarios: readonly HistorianEvalScenario[],
    ids: ReadonlySet<string>,
): { releaseDir: string; artifactFingerprint: string } {
    // Promotion runs tombstone, approval, and version-collision checks before recomputing the battery to avoid unnecessary battery work.
    const prior = installedReleases(input.releasesRoot);
    const inherited = inheritedTombstones(prior);
    const tombstones = [...new Set([...inherited, ...(input.tombstones ?? [])])].sort();
    // Promotion scans inherited IDs against this promotion's deny lists because the immutable manifest republishes them.
    const tombstonePrivacy = scanForSensitiveContent(
        { tombstones },
        { forbiddenTokens: input.forbiddenTokens, forbiddenIdentifiers: input.forbiddenIdentifiers },
    ).map((violation) => `privacy.${violation.category}: ${violation.path}`);
    if (tombstonePrivacy.length > 0) fail(tombstonePrivacy.sort());
    for (const id of tombstones) {
        if (ids.has(id)) fail([`release.scenarios.${id}: tombstoned`]);
    }

    const releaseTuple = buildReleaseTuple(scenarios);
    const nextLineage: ReleaseLineage = { releaseVersion: input.releaseVersion, tombstones };
    const releaseFingerprint = releaseApprovalFingerprint({
        releaseVersion: input.releaseVersion,
        releaseTuple,
        tombstones,
    });
    const approvals = checkApprovals(input.approvals, releaseFingerprint);

    const destination = join(input.releasesRoot, input.releaseVersion);
    if (existsSync(destination)) {
        // Promotion never modifies an existing release.
        // Promotion checks destination collisions before succession so re-promoting the newest version reports a collision.
        fail(["release: version already installed"]);
    }
    // Promotion checks succession against the newest installed release, not only the destination version.
    const newest = prior.at(-1);
    if (newest !== undefined) {
        assertReleaseSuccession(newest, nextLineage);
    }

    // Promotion recomputes the mutation battery instead of accepting caller-supplied evidence.
    const evidence = runMutationBattery(scenarios);
    checkMutationEvidence(evidence, scenarios);

    const manifest: ReleaseManifest = {
        schema: MANIFEST_SCHEMA,
        releaseVersion: input.releaseVersion,
        releaseTuple,
        approvals,
        tombstones,
    };

    // `loadRelease` must accept the review bytes before publication.
    const reviewDir = mkdtempSync(join(realpathSync.native(tmpdir()), "historian-eval-promote-"));
    try {
        if (hasGitAncestor(reviewDir)) {
            fail(["release: review directory must live outside version control"]);
        }
        writeReleaseTree(reviewDir, manifest, scenarios, evidence);
        loadRelease(reviewDir);
    } finally {
        rmSync(reviewDir, { recursive: true, force: true });
    }

    // A crash after `mkdtempSync` and before `renameSync` can leave a `.staging-*` directory.
    // `renameSync(staging, destination)` publishes a staged tree.
    for (const entry of readdirSync(input.releasesRoot)) {
        if (entry.startsWith(".staging-")) {
            rmSync(join(input.releasesRoot, entry), { recursive: true, force: true });
        }
    }
    const staging = mkdtempSync(join(input.releasesRoot, ".staging-"));
    try {
        writeReleaseTree(staging, manifest, scenarios, evidence);
        // `loadRelease` must validate the staged tree before `renameSync` publishes it.
        loadRelease(staging);
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    //
    return {
        releaseDir: destination,
        artifactFingerprint: releaseArtifactFingerprint(manifest, evidence, scenarios),
    };
}
