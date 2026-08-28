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
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { hasGitAncestor } from "../../../plugin/scripts/retrieval-benchmark/fs-boundary";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import {
    APPROVAL_KINDS,
    HistorianEvalContractError,
    MANIFEST_SCHEMA,
    RELEASE_VERSION_RE,
    buildReleaseTuple,
    lintCorpus,
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
}

function fail(diagnostics: string[]): never {
    throw new HistorianEvalContractError(diagnostics);
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
    // An artifact that declares its own battery red is not loadable, whatever
    // its per-scenario entries say. Without this, valid green entries for every
    // release scenario plus one extra red entry is internally consistent with
    // `green: false` and still passes.
    if (!evidence.green) diagnostics.push("mutation-evidence: not-green");
    const byFingerprint = new Map(evidence.scenarios.map((entry) => [entry.scenarioFingerprint, entry]));
    const matched = new Set<string>();
    for (const scenario of scenarios) {
        const fingerprint = scenarioFingerprint(scenario);
        const entry = byFingerprint.get(fingerprint);
        if (entry === undefined) {
            diagnostics.push(`mutation-evidence.${scenario.id}: missing`);
        } else if (!entry.green) {
            diagnostics.push(`mutation-evidence.${scenario.id}: not-green`);
        } else {
            matched.add(fingerprint);
        }
    }
    // One-to-one: an entry for a scenario outside the release is evidence
    // about something the release does not contain.
    for (const entry of evidence.scenarios) {
        if (!matched.has(entry.scenarioFingerprint)) {
            diagnostics.push(`mutation-evidence.${entry.scenarioId}: not-in-release`);
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
    const manifest = parseManifest(JSON.parse(readFileSync(join(releaseDir, RELEASE_FILES.manifest), "utf8")));
    const scenarioFiles = readdirSync(join(releaseDir, RELEASE_FILES.scenariosDir)).sort();
    const scenarios = scenarioFiles.map((file) =>
        parseScenario(JSON.parse(readFileSync(join(releaseDir, RELEASE_FILES.scenariosDir, file), "utf8")), file),
    );
    const diagnostics: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
        if (scenarioFiles[index] !== `${scenario.id}.json`) {
            diagnostics.push(`release.scenarios.${scenarioFiles[index]}: filename-id-mismatch`);
        }
        if (manifest.tombstones.includes(scenario.id)) {
            diagnostics.push(`release.scenarios.${scenario.id}: tombstoned`);
        }
    }
    // Corpus-level admission lint (non-empty, unique ids, family coverage)
    // so a hand-built or truncated release cannot pass the consumer path
    // that the per-PR lint gate would reject.
    diagnostics.push(...lintCorpus(scenarios));
    if (scenarios.length < 10 || scenarios.length > 30) {
        diagnostics.push(`release: corpus size ${scenarios.length} outside the 10-30 budget (R1)`);
    }
    if (diagnostics.length > 0) fail(diagnostics);
    const tuple = buildReleaseTuple(scenarios);
    if (canonicalFingerprint(tuple) !== canonicalFingerprint(manifest.releaseTuple)) {
        fail(["release: corpus does not match the manifest release tuple"]);
    }
    const mutationEvidence = parseMutationEvidence(
        JSON.parse(readFileSync(join(releaseDir, RELEASE_FILES.evidence), "utf8")),
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
        // Fail closed: atomic promotion never intentionally leaves a versioned
        // directory without a manifest, so one that exists is a partial or
        // damaged release. Skipping it would promote a later release that does
        // not inherit its tombstones, resurrecting a scenario this function's
        // invariant says stays rejected forever.
        if (!existsSync(manifestPath)) {
            fail([`release.prior.${entry}: manifest-missing`]);
        }
        const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
        for (const id of manifest.tombstones) tombstones.add(id);
    }
    return [...tombstones].sort();
}

export function promoteRelease(input: PromotionInput): { releaseDir: string } {
    if (!RELEASE_VERSION_RE.test(input.releaseVersion)) {
        fail(["release: version-invalid"]);
    }

    // Privacy gate FIRST — before any parser, because schema diagnostics
    // interpolate scenario ids and field paths. Every caller-supplied value
    // that reaches the frozen tree is scanned, approvals included: `approver`
    // is free-form and is published verbatim in `manifest.json`, so an email
    // address, secret, or absolute path there would otherwise be frozen
    // unexamined.
    const privacyDiagnostics: string[] = [];
    const scanCallerInput = (raw: unknown, label: string): void => {
        for (const violation of scanForSensitiveContent(raw, { forbiddenTokens: input.forbiddenTokens })) {
            privacyDiagnostics.push(`privacy.${violation.category}: ${label} ${violation.path}`);
        }
    };
    for (const [index, raw] of input.scenarios.entries()) scanCallerInput(raw, `scenarios[${index}]`);
    for (const [index, raw] of input.approvals.entries()) scanCallerInput(raw, `approvals[${index}]`);
    if (privacyDiagnostics.length > 0) fail(privacyDiagnostics.sort());

    const scenarios = input.scenarios.map((raw, index) => parseScenario(raw, `scenarios[${index}]`));
    // Shared corpus admission lint: the freeze gate must reject everything
    // the per-PR `--lint` gate rejects (including hard-negative family
    // coverage), or a release could freeze in a state that keeps
    // `--lint --release` permanently red. The release size budget is
    // reported in the same batch so one failure surfaces every corpus
    // diagnostic.
    const lintDiagnostics = lintCorpus(scenarios);
    if (scenarios.length < 10 || scenarios.length > 30) {
        lintDiagnostics.push(`release: corpus size ${scenarios.length} outside the 10-30 budget (R1)`);
    }
    if (lintDiagnostics.length > 0) fail(lintDiagnostics.sort());
    const ids = new Set(scenarios.map((scenario) => scenario.id));

    // Admission gate (R13): the battery is recomputed here rather than
    // accepted from the caller, so no scenario can enter a frozen release
    // with forged or stale evidence; the recomputed artifact is what gets
    // published beside the corpus.
    const evidence = runMutationBattery(scenarios);
    checkMutationEvidence(evidence, scenarios);

    const inherited = inheritedTombstones(input.releasesRoot);
    const tombstones = [...new Set([...inherited, ...(input.tombstones ?? [])])].sort();
    for (const id of tombstones) {
        if (ids.has(id)) fail([`release.scenarios.${id}: tombstoned`]);
    }

    const releaseTuple = buildReleaseTuple(scenarios);
    const tupleFingerprint = canonicalFingerprint(releaseTuple);
    const approvals = checkApprovals(input.approvals, tupleFingerprint);
    const manifest: ReleaseManifest = {
        schema: MANIFEST_SCHEMA,
        releaseVersion: input.releaseVersion,
        releaseTuple,
        approvals,
        tombstones,
    };

    const destination = join(input.releasesRoot, input.releaseVersion);
    if (existsSync(destination)) {
        // Immutability: an existing release is never modified; errata go
        // into vN+1 (R12).
        fail(["release: version already installed"]);
    }

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
