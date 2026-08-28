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
    buildReleaseTuple,
    lintScenario,
    parseApproval,
    parseManifest,
    parseScenario,
    scenarioFingerprint,
    type Approval,
    type ApprovalKind,
    type HistorianEvalScenario,
    type ReleaseManifest,
} from "./contract";
import { parseMutationEvidence, runMutationBattery, type MutationEvidenceArtifact } from "./mutations";

export const RELEASE_FILES = {
    manifest: "manifest.json",
    evidence: "mutation-evidence.json",
    scenariosDir: "scenarios",
} as const;

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

function checkApprovals(rawApprovals: readonly unknown[], tupleFingerprint: string): { privacy: Approval; goldIntent: Approval } {
    const approvals = rawApprovals.map((raw, index) => parseApproval(raw, `approvals[${index}]`));
    const byKind = new Map<ApprovalKind, Approval>();
    const diagnostics: string[] = [];
    for (const approval of approvals) {
        if (byKind.has(approval.kind)) diagnostics.push(`approvals.${approval.kind}: duplicate-kind`);
        byKind.set(approval.kind, approval);
        if (approval.releaseTupleFingerprint !== tupleFingerprint) {
            diagnostics.push(`approvals.${approval.kind}: stale-or-foreign-tuple`);
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
 * Strict consumer path: load a release directory back through the full
 * parse + lint + fingerprint pipeline. Fails closed on unexpected entries,
 * fingerprint drift, tombstoned scenarios present in the corpus, or
 * missing/ungreen mutation evidence.
 */
export function loadRelease(releaseDir: string): {
    manifest: ReleaseManifest;
    scenarios: HistorianEvalScenario[];
    mutationEvidence: MutationEvidenceArtifact;
} {
    const entries = readdirSync(releaseDir).sort();
    const expected: string[] = [RELEASE_FILES.evidence, RELEASE_FILES.manifest, RELEASE_FILES.scenariosDir];
    const unexpected = entries.filter((entry) => !expected.includes(entry));
    if (unexpected.length > 0 || entries.length !== expected.length) {
        fail([`release: unexpected entries (${unexpected.length > 0 ? unexpected.join(", ") : "missing files"})`]);
    }
    const manifest = parseManifest(readReleaseJson(join(releaseDir, RELEASE_FILES.manifest), "release.manifest"));
    const scenarioFiles = readdirSync(join(releaseDir, RELEASE_FILES.scenariosDir)).sort();
    const scenarios = scenarioFiles.map((file) =>
        parseScenario(readReleaseJson(join(releaseDir, RELEASE_FILES.scenariosDir, file), `release.scenarios.${file}`), file),
    );
    const diagnostics: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
        if (scenarioFiles[index] !== `${scenario.id}.json`) {
            diagnostics.push(`release.scenarios.${scenarioFiles[index]}: filename-id-mismatch`);
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
    const mutationEvidence = parseMutationEvidence(
        readReleaseJson(join(releaseDir, RELEASE_FILES.evidence), "release.mutation-evidence"),
    );
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

/** Prior releases' tombstones persist in every later release (R12). */
function inheritedTombstones(releasesRoot: string): string[] {
    if (!existsSync(releasesRoot)) return [];
    const tombstones = new Set<string>();
    for (const entry of readdirSync(releasesRoot)) {
        if (!RELEASE_VERSION_RE.test(entry)) continue;
        const manifestPath = join(releasesRoot, entry, RELEASE_FILES.manifest);
        // Fail closed: a version-named directory without a loadable manifest
        // is a corrupt releases root, and skipping it would silently drop its
        // tombstones — re-admitting a retracted scenario into vN+1.
        if (!existsSync(manifestPath)) {
            fail([`release: prior release ${entry} has no readable manifest; refusing to inherit tombstones`]);
        }
        const manifest = parseManifest(readReleaseJson(manifestPath, `release.${entry}.manifest`));
        for (const id of manifest.tombstones) tombstones.add(id);
    }
    return [...tombstones].sort();
}

export function promoteRelease(input: PromotionInput): { releaseDir: string } {
    if (!RELEASE_VERSION_RE.test(input.releaseVersion)) {
        fail(["release: version-invalid"]);
    }

    // Privacy gate FIRST — before any parser, because schema diagnostics
    // interpolate scenario ids and field paths. Approvals are scanned too:
    // approver strings are published verbatim into the immutable manifest.
    const privacyDiagnostics = scanForSensitiveContent(
        { scenarios: input.scenarios, approvals: input.approvals },
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
    if (scenarios.length < 10 || scenarios.length > 30) {
        fail([`release: corpus size ${scenarios.length} outside the 10-30 budget (R1)`]);
    }

    // Cheap rejection gates run before the battery: tombstone conflicts,
    // approval binding, and version collisions each reject in microseconds,
    // while the recomputed battery costs seconds per promotion.
    const inherited = inheritedTombstones(input.releasesRoot);
    const tombstones = [...new Set([...inherited, ...(input.tombstones ?? [])])].sort();
    for (const id of tombstones) {
        if (ids.has(id)) fail([`release.scenarios.${id}: tombstoned`]);
    }

    const releaseTuple = buildReleaseTuple(scenarios);
    const tupleFingerprint = canonicalFingerprint(releaseTuple);
    const approvals = checkApprovals(input.approvals, tupleFingerprint);

    const destination = join(input.releasesRoot, input.releaseVersion);
    if (existsSync(destination)) {
        // Immutability: an existing release is never modified; errata go
        // into vN+1 (R12).
        fail(["release: version already installed"]);
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
    return { releaseDir: destination };
}
