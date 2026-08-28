/**
 * Historian structural eval lane — freeze governance (R11/R12/KD4 via KTD7).
 *
 * Clones the retrieval-benchmark promotion pattern: privacy scan before any
 * parser, operator-supplied approvals (one per kind: privacy, gold-intent)
 * bound to the exact release-tuple fingerprint, owner-only review directory
 * outside version control, atomic rename into an immutable release
 * directory, and tombstone-in-vN+1 errata — existing releases are never
 * edited. Generic modules (`canonicalFingerprint`, the privacy scan) are
 * imported directly; the retrieval lane's own contract/promote stay frozen
 * governance code, cloned in structure only.
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
import { join } from "node:path";
import { canonicalFingerprint, readCanonicalJsonFile } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { hasGitAncestor } from "../../../plugin/scripts/retrieval-benchmark/fs-boundary";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    APPROVAL_KINDS,
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

/** Corpus-size budget (R1), enforced identically by promotion and by loading. */
export const CORPUS_SIZE_BUDGET = { min: 10, max: 30 } as const;

export interface PromotionInput {
    /** Raw scenario documents (unparsed: the privacy gate runs first). */
    scenarios: readonly unknown[];
    /** Operator-supplied approvals, exactly one per kind. Never minted here. */
    approvals: readonly unknown[];
    releasesRoot: string;
    releaseVersion: string;
    /** Errata carried forward from prior releases plus any new tombstones (R12). */
    tombstones?: readonly string[];
    forbiddenTokens?: readonly string[];
    /** Word-bounded username/identifier deny list, forwarded to the privacy scan. */
    forbiddenIdentifiers?: readonly string[];
}

function fail(diagnostics: string[]): never {
    throw new HistorianEvalContractError(diagnostics);
}

/**
 * Byte-strict release read-back: fingerprints are computed over PARSED
 * values, so a plain `JSON.parse` would let an in-place edit of an installed
 * release (duplicate members — where a reviewer sees the first value and the
 * code takes the last — or re-serialized bytes) pass the tamper checks.
 * Canonical-byte verification rejects anything `writeReleaseTree` did not
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
        // Bound to the WHOLE release — version, tuple, and tombstones — so a
        // prior release's approvals cannot be replayed on a manifest that drops
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

function checkMutationEvidence(
    evidence: MutationEvidenceArtifact,
    scenarios: readonly HistorianEvalScenario[],
): void {
    const diagnostics: string[] = [];
    const byFingerprint = new Map(evidence.scenarios.map((entry) => [entry.scenarioFingerprint, entry]));
    for (const scenario of scenarios) {
        const entry = byFingerprint.get(scenarioFingerprint(scenario));
        if (entry === undefined) {
            diagnostics.push(`mutation-evidence.${scenario.id}: missing`);
        } else if (!entry.green) {
            diagnostics.push(`mutation-evidence.${scenario.id}: not-green`);
        }
    }
    if (diagnostics.length > 0) fail(diagnostics);
}

/**
 * Fingerprint over BOTH published artifacts — the manifest (including approver
 * strings) and the recomputed mutation evidence. This is the value an operator
 * records out of band at promotion time and passes back to `loadRelease`:
 * nothing inside the release directory can authenticate itself, so without an
 * external anchor an editor can rewrite `approver`, or fabricate green evidence
 * for a battery that never ran, and still satisfy every in-directory check.
 *
 * Both files are covered because they are separately mutable. Anchoring only
 * the manifest would leave the evidence file forgeable: the parser proves an
 * artifact is internally consistent and covers every mutation class, not that
 * any mutation was ever executed.
 */
export function releaseArtifactFingerprint(
    manifest: ReleaseManifest,
    evidence: MutationEvidenceArtifact,
): string {
    return canonicalFingerprint({ manifest, mutationEvidence: evidence });
}

/** Real regular file — not a symlink whose target lives outside the frozen tree. */
function assertRegularFile(path: string, label: string): void {
    if (!lstatSync(path).isFile()) fail([`${label}: not-a-regular-file`]);
}

export interface LoadReleaseOptions {
    /**
     * Expected `releaseArtifactFingerprint`, from a trust anchor outside the
     * release directory. Omit only when the caller already trusts the tree (the
     * promoter's own read-back of bytes it just wrote).
     */
    expectedArtifactFingerprint?: string;
}

/**
 * Strict consumer path: load a release directory back through the full
 * parse + lint + fingerprint pipeline. Fails closed on unexpected entries,
 * symlinked artifacts, a corpus outside the size budget, fingerprint drift,
 * tombstoned scenarios present in the corpus, or missing/ungreen mutation
 * evidence.
 */
export function loadRelease(
    releaseDir: string,
    options: LoadReleaseOptions = {},
): {
    manifest: ReleaseManifest;
    scenarios: HistorianEvalScenario[];
    mutationEvidence: MutationEvidenceArtifact;
} {
    const entries = readdirSync(releaseDir).sort();
    const expected: string[] = [RELEASE_FILES.evidence, RELEASE_FILES.manifest, RELEASE_FILES.scenariosDir];
    const unexpected = entries.filter((entry) => !expected.includes(entry));
    if (unexpected.length > 0 || entries.length !== expected.length) {
        // Counts only: entry names from an externally assembled tree have not
        // been through the privacy scan (which covers scenario values, not
        // filesystem names), so echoing them would push unreviewed text —
        // a forbidden token, customer identifier, or local path — into logs.
        fail([
            `release: unexpected entries (${unexpected.length} unexpected of ${entries.length}, expected ${expected.length})`,
        ]);
    }
    // Name checks alone are satisfied by symlinks, and every read below
    // follows them: a self-consistent link farm would pass `loadRelease`
    // while later runs load bytes that can change outside the supposedly
    // immutable release directory.
    assertRegularFile(join(releaseDir, RELEASE_FILES.manifest), "release.manifest");
    assertRegularFile(join(releaseDir, RELEASE_FILES.evidence), "release.mutation-evidence");
    const scenariosDir = join(releaseDir, RELEASE_FILES.scenariosDir);
    if (!lstatSync(scenariosDir).isDirectory()) fail(["release.scenarios: not-a-real-directory"]);

    const manifest = parseManifest(readReleaseJson(join(releaseDir, RELEASE_FILES.manifest), "release.manifest"));
    const mutationEvidence = parseMutationEvidence(
        readReleaseJson(join(releaseDir, RELEASE_FILES.evidence), "release.mutation-evidence"),
    );
    // Anchor check before any content is trusted, and over BOTH artifacts: the
    // evidence file is separately mutable, and its parser proves internal
    // consistency and full class coverage — not that the battery ever ran.
    if (
        options.expectedArtifactFingerprint !== undefined &&
        releaseArtifactFingerprint(manifest, mutationEvidence) !== options.expectedArtifactFingerprint
    ) {
        fail(["release: artifact fingerprint does not match the expected trust anchor"]);
    }
    const scenarioFiles = readdirSync(scenariosDir).sort();
    // Position-based labels, for the same reason the entry check above reports
    // counts: a scenario filename from an externally assembled tree has not been
    // through the privacy scan (which covers scenario values, not filesystem
    // names). `parseScenario` prefixes every validation diagnostic with its
    // label, so a filename there would push unreviewed text — a forbidden token,
    // customer identifier, or local path — into logs on any malformed scenario.
    // The index is enough to locate the file, since the list is sorted.
    for (const [index, file] of scenarioFiles.entries()) {
        assertRegularFile(join(scenariosDir, file), `release.scenarios[${index}]`);
    }
    // The same budget promotion enforces (R1): a separately assembled or
    // truncated release must not pass the strict path with a corpus that
    // promotion would reject.
    if (scenarioFiles.length < CORPUS_SIZE_BUDGET.min || scenarioFiles.length > CORPUS_SIZE_BUDGET.max) {
        fail([
            `release: corpus size ${scenarioFiles.length} outside the ${CORPUS_SIZE_BUDGET.min}-${CORPUS_SIZE_BUDGET.max} budget (R1)`,
        ]);
    }
    const scenarios = scenarioFiles.map((file, index) =>
        parseScenario(
            readReleaseJson(join(scenariosDir, file), `release.scenarios[${index}]`),
            `release.scenarios[${index}]`,
        ),
    );
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

/** Ordinal of a `vN` directory name. Canonical form only — see `promoteRelease`. */
function versionOrdinal(version: string): number {
    return Number(version.slice(1));
}

/**
 * Every installed release, newest last. One pass serves both obligations that
 * read prior state: tombstone inheritance (R12) and succession, so they cannot
 * disagree about which releases exist.
 *
 * Prior releases are read as LINEAGE, not re-certified as current manifests.
 * `parseManifest` pins the scenario-schema, privacy-policy, and sanitizer
 * versions to the ones this lane implements, so rotating any of them would make
 * every already-installed manifest unparseable and block all further promotion —
 * precisely when those releases' tombstones still have to be carried forward. A
 * predecessor is consulted for what it retired, not approved again.
 *
 * Fails closed on a version-named directory without a loadable manifest: a
 * corrupt releases root read as "carries no tombstones" would silently
 * re-admit a retracted scenario into vN+1.
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
            const lineage = parseReleaseLineage(
                readReleaseJson(manifestPath, `release.${entry}.manifest`),
                `release.${entry}.manifest`,
            );
            // Ordering above is by DIRECTORY name, but succession is enforced
            // against the manifest's own `releaseVersion`. A manifest copied into
            // a differently named directory — a v1 manifest under v100 — would
            // sort newest while reporting v1, so promoting v2 would be compared
            // against v1 and admitted, leaving the numerically later, immutable
            // v100 still serving a scenario v2 retired. Both names are
            // `RELEASE_VERSION_RE`-bounded, so reporting them echoes no artifact
            // content.
            if (lineage.releaseVersion !== entry) {
                fail([`release: prior release ${entry} declares version ${lineage.releaseVersion}`]);
            }
            return lineage;
        });
}

/** Prior releases' tombstones persist in every later release (R12). */
function inheritedTombstones(prior: readonly ReleaseLineage[]): string[] {
    const tombstones = new Set<string>();
    for (const lineage of prior) {
        for (const id of lineage.tombstones) tombstones.add(id);
    }
    return [...tombstones].sort();
}

export function promoteRelease(input: PromotionInput): { releaseDir: string; artifactFingerprint: string } {
    if (!RELEASE_VERSION_RE.test(input.releaseVersion)) {
        fail(["release: version-invalid"]);
    }
    // Canonical form only: `v01` and `v1` share an ordinal, so accepting both
    // would let two distinct directory names claim the same release position
    // and defeat the monotonicity check below.
    if (input.releaseVersion !== `v${versionOrdinal(input.releaseVersion)}`) {
        fail(["release: version-not-canonical"]);
    }

    // Privacy gate FIRST — before any parser, because schema diagnostics
    // interpolate scenario ids and field paths. Approvals and tombstones are
    // scanned too: approver strings are published verbatim into the immutable
    // manifest, and a tombstone id is an operator-authored string that every
    // LATER manifest also carries forward.
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

    // Cheap rejection gates run before the battery: tombstone conflicts,
    // approval binding, and version collisions each reject in microseconds,
    // while the recomputed battery costs seconds per promotion.
    const prior = installedReleases(input.releasesRoot);
    const inherited = inheritedTombstones(prior);
    const tombstones = [...new Set([...inherited, ...(input.tombstones ?? [])])].sort();
    // Inherited ids get scanned too, against THIS promotion's deny lists: they
    // are about to be republished into a new immutable manifest, and the lists
    // can name something no earlier promotion was told to reject.
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
        // Immutability: an existing release is never modified; errata go
        // into vN+1 (R12). Checked before succession so re-promoting the
        // newest version reports the collision rather than the weaker
        // "not later than" diagnostic.
        fail(["release: version already installed"]);
    }
    // Succession against the newest installed release, not just the exact
    // destination: publishing v1 after v2 would leave the numerically later —
    // and immutable — v2 still serving a scenario v1 retired, so the vN+1
    // errata rule could never retire it. The contract owns this rule (it also
    // refuses dropped tombstones) so promotion and manifest audit agree.
    const newest = prior.at(-1);
    if (newest !== undefined) {
        assertReleaseSuccession(newest, nextLineage);
    }

    // Admission gate (R13): the battery is recomputed here rather than
    // accepted from the caller, so no scenario can enter a frozen release
    // with forged or stale evidence; the recomputed artifact is what gets
    // published beside the corpus.
    const evidence = runMutationBattery(scenarios);
    checkMutationEvidence(evidence, scenarios);

    const manifest: ReleaseManifest = {
        schema: MANIFEST_SCHEMA,
        releaseVersion: input.releaseVersion,
        releaseTuple,
        approvals,
        tombstones,
    };

    // Owner-only review directory OUTSIDE version control: the reviewed
    // bytes must be exactly what the strict consumer path accepts.
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

    mkdirSync(input.releasesRoot, { recursive: true });
    // A crash between staging and rename strands a fully populated
    // `.staging-*` tree beside the releases, where it would be committable.
    // Staged trees are unpublished by construction (publication is the
    // atomic rename), and promotions are operator-serial per releases root,
    // so removing leftovers here is safe.
    for (const entry of readdirSync(input.releasesRoot)) {
        if (entry.startsWith(".staging-")) {
            rmSync(join(input.releasesRoot, entry), { recursive: true, force: true });
        }
    }
    const staging = mkdtempSync(join(input.releasesRoot, ".staging-"));
    try {
        writeReleaseTree(staging, manifest, scenarios, evidence);
        // Tamper check: re-load the exact staged bytes before publication.
        loadRelease(staging);
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    // The caller records this out of band; it is the only anchor that lets a
    // later `loadRelease` detect an edited approver string or forged evidence.
    return { releaseDir: destination, artifactFingerprint: releaseArtifactFingerprint(manifest, evidence) };
}
