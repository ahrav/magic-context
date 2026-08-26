import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
    canonicalFingerprint,
    canonicalJson,
    readCanonicalJsonFile,
} from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import type { LifecycleEvent } from "./lifecycle";
import {
    type CohortCloseManifest,
    type PolicyOwnerDocument,
    type ReleaseFreezeManifest,
    type TrustedManifestEntry,
    HoldoutContractError,
    parseCloseManifest,
    parseFreezeManifest,
    parsePolicyOwnerDocument,
    parseTrustedManifestEntry,
} from "./contract";

const MANIFEST_FILE = "manifest.json";

function privacyFirst(raw: unknown, options: PrivacyOptions): void {
    const violations = scanForSensitiveContent(raw, options);
    if (violations.length > 0) {
        throw new HoldoutContractError(
            violations.map((entry) => `privacy.${entry.category}:${entry.path}`),
        );
    }
}

export interface PrivacyOptions {
    forbiddenTokens?: readonly string[];
    forbiddenIdentifiers?: readonly string[];
}

function assertArtifactDirectory(path: string): void {
    let entries: string[];
    try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new HoldoutContractError(["artifact: directory-not-regular"]);
        }
        entries = readdirSync(path);
    } catch (error) {
        if (error instanceof HoldoutContractError) throw error;
        throw new HoldoutContractError(["artifact: unreadable"]);
    }
    if (entries.length !== 1 || entries[0] !== MANIFEST_FILE) {
        throw new HoldoutContractError(["artifact: entries-invalid"]);
    }
    if (!lstatSync(join(path, MANIFEST_FILE)).isFile()) {
        throw new HoldoutContractError(["artifact: manifest-not-regular"]);
    }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function readManifest(path: string): JsonValue {
    assertArtifactDirectory(path);
    return readCanonicalJsonFile(join(path, MANIFEST_FILE), (code) =>
        new HoldoutContractError([`artifact.manifest:${code}`]),
    ) as JsonValue;
}

export interface PolicyDocuments {
    analysis: PolicyOwnerDocument;
    scorecard: PolicyOwnerDocument;
}

export function loadPolicyDocuments(analysisPath: string, scorecardPath: string): PolicyDocuments {
    const analysisRaw = readCanonicalJsonFile(analysisPath, (code) =>
        new HoldoutContractError([`policy.analysis:${code}`]),
    );
    const scorecardRaw = readCanonicalJsonFile(scorecardPath, (code) =>
        new HoldoutContractError([`policy.scorecard:${code}`]),
    );
    privacyFirst({ analysis: analysisRaw, scorecard: scorecardRaw }, {});
    return {
        analysis: parsePolicyOwnerDocument(analysisRaw, "magic-context-x4l.14"),
        scorecard: parsePolicyOwnerDocument(scorecardRaw, "magic-context-x4l.15"),
    };
}

function readyPolicySchema(policy: unknown, label: string): string {
    if (!policy || typeof policy !== "object" || Array.isArray(policy) || typeof (policy as { schema?: unknown }).schema !== "string") {
        throw new HoldoutContractError([`${label}: schema-missing`]);
    }
    return (policy as { schema: string }).schema;
}

export function validateFreezePolicies(freeze: ReleaseFreezeManifest, policies: PolicyDocuments): void {
    if (policies.analysis.status !== "ready" || policies.scorecard.status !== "ready") {
        throw new HoldoutContractError(["freeze.policies: sibling-policy-pending"]);
    }
    if (freeze.body.policies.analysis.policyFingerprint !== policies.analysis.policyFingerprint) {
        throw new HoldoutContractError(["freeze.policies.analysis: fingerprint-mismatch"]);
    }
    if (freeze.body.policies.scorecard.policyFingerprint !== policies.scorecard.policyFingerprint) {
        throw new HoldoutContractError(["freeze.policies.scorecard: fingerprint-mismatch"]);
    }
    if (freeze.body.policies.analysis.schemaVersion !== readyPolicySchema(policies.analysis.policy, "freeze.policies.analysis")) {
        throw new HoldoutContractError(["freeze.policies.analysis: schema-version-mismatch"]);
    }
    if (freeze.body.policies.scorecard.schemaVersion !== readyPolicySchema(policies.scorecard.policy, "freeze.policies.scorecard")) {
        throw new HoldoutContractError(["freeze.policies.scorecard: schema-version-mismatch"]);
    }
}

/**
 * Name `mkdtempSync` gives a staging directory: the fixed prefix this module passes as
 * the template plus the six random characters `XXXXXX` becomes. No artifact name begins
 * with a dot, and the fixed length refuses a longer name that merely starts the same
 * way, so the pattern cannot match an artifact. Readers of an artifact parent recognise
 * staging directories by this pattern, so it lives with the code that produces them.
 */
export const STAGING_ENTRY_RE = /^\.staging-[A-Za-z0-9]{6}$/;

/**
 * How long a staging directory must sit untouched before a publish treats it as
 * orphaned rather than as another publisher's work in progress.
 *
 * `mkdtempSync` picks the name at random and nothing records who created it, so there
 * is no owner to interrogate the way a lock's record names its holder, and no lease is
 * published either. Age is the only evidence available. A publisher holds a staging
 * directory across one write, one canonical re-read and one rename, with no wait in
 * between, so a live one was touched a few filesystem operations ago; a minute is
 * orders of magnitude beyond that window.
 */
const STAGING_ORPHAN_AGE_MS = 60_000;

/**
 * Removes staging directories in `parent` that no publisher can still be holding.
 *
 * A publisher killed between `mkdtempSync` and `renameSync` leaves its staging
 * directory beside the artifacts. An identical retry publishes through the
 * accept-existing path without touching that leftover, while the epoch artifact-set
 * check reads it as an entry no artifact owns, so the retry documented as the recovery
 * cannot finish it. Sweeping on the way into every publish, including that retry, is
 * what completes the recovery without an operator deleting files by hand.
 *
 * With only age as evidence, the threshold is what protects a live publisher. Removing
 * a live directory costs that publisher its `renameSync` and nothing else: the rename
 * is the only step that installs a destination, and it moves a directory whose manifest
 * has already been written and re-read, so a removal cannot leave partial bytes behind
 * at the destination.
 */
function reclaimOrphanedStaging(parent: string): void {
    let entries: string[];
    try {
        entries = readdirSync(parent);
    } catch {
        // An unreadable parent holds no orphan this publish can act on, and the publish
        // below reports whatever is actually wrong with the path.
        return;
    }
    for (const entry of entries) {
        if (!STAGING_ENTRY_RE.test(entry)) continue;
        const path = join(parent, entry);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        // A publish only ever creates a directory under this name. Anything else is not
        // a staging directory this reclaim owns, and a symlink would move the removal
        // outside the parent.
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
        if (Date.now() - stat.mtimeMs <= STAGING_ORPHAN_AGE_MS) continue;
        rmSync(path, { recursive: true, force: true });
    }
}

function writeArtifactAtomically(value: unknown, destination: string): void {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const parent = dirname(destination);
    const acceptExisting = (): boolean => {
        if (!existsSync(destination)) return false;
        assertArtifactDirectory(destination);
        if (readFileSync(join(destination, MANIFEST_FILE), "utf8") !== bytes) {
            throw new HoldoutContractError(["artifact: destination-conflict"]);
        }
        return true;
    };
    // The sweep runs ahead of the accept-existing return because a killed publisher's
    // destination may already hold the artifact, and the identical retry is then the
    // only run that reaches this parent again.
    reclaimOrphanedStaging(parent);
    if (acceptExisting()) return;
    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, ".staging-"));
    try {
        writeFileSync(join(staging, MANIFEST_FILE), bytes, { flag: "wx" });
        readCanonicalJsonFile(join(staging, MANIFEST_FILE), (code) =>
            new HoldoutContractError([`artifact.staging:${code}`]),
        );
        renameSync(staging, destination);
    } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (acceptExisting()) return;
        throw error;
    }
}

export function publishFreeze(
    raw: unknown,
    destination: string,
    policies: PolicyDocuments,
    privacy: PrivacyOptions = {},
): { manifest: ReleaseFreezeManifest; manifestFingerprint: string } {
    privacyFirst(raw, privacy);
    const manifest = parseFreezeManifest(raw);
    validateFreezePolicies(manifest, policies);
    writeArtifactAtomically(manifest, destination);
    return loadFreeze(destination, canonicalFingerprint(manifest), policies, privacy);
}

export function loadFreeze(
    artifactDir: string,
    expectedManifestFingerprint: string,
    policies: PolicyDocuments,
    privacy: PrivacyOptions = {},
): { manifest: ReleaseFreezeManifest; manifestFingerprint: string } {
    const raw = readManifest(artifactDir);
    privacyFirst(raw, privacy);
    const manifestFingerprint = canonicalFingerprint(raw);
    if (manifestFingerprint !== expectedManifestFingerprint) {
        throw new HoldoutContractError(["freeze.manifest: untrusted"]);
    }
    const manifest = parseFreezeManifest(raw);
    validateFreezePolicies(manifest, policies);
    return { manifest, manifestFingerprint };
}

type TrustedFreeze = { manifest: ReleaseFreezeManifest; manifestFingerprint: string };

/**
 * The complete set of close-versus-freeze binding invariants, enforced
 * identically by every entry point.
 *
 * Repository validation reads an installed close through `loadClose` and never
 * calls `publishClose`, so an invariant checked only while publishing is not
 * enforced at all against a close artifact written directly into a repository.
 * Holding the comparisons in one body is what keeps the two paths from admitting
 * different manifests.
 *
 * `linkMismatch` is the only sanctioned difference between callers: the publish
 * path names the diverging link field for the operator authoring the manifest,
 * while the load path reports a single code for either field. The cutoff code is
 * shared because both paths reject the same condition for the same reason.
 */
function assertCloseBoundToFreeze(
    manifest: CohortCloseManifest,
    trustedFreeze: TrustedFreeze,
    linkMismatch: { epochId: string; freezeManifestFingerprint: string },
): void {
    if (manifest.body.epochId !== trustedFreeze.manifest.body.epochId) {
        throw new HoldoutContractError([linkMismatch.epochId]);
    }
    if (manifest.body.freezeManifestFingerprint !== trustedFreeze.manifestFingerprint) {
        throw new HoldoutContractError([linkMismatch.freezeManifestFingerprint]);
    }
    // The frozen intake window bounds admission: a close stamped before that
    // window ends discards reports the epoch is still obliged to admit.
    if (Date.parse(manifest.body.closedAt) < Date.parse(trustedFreeze.manifest.body.intakeWindow.closesAt)) {
        throw new HoldoutContractError(["close.closedAt: before-cutoff"]);
    }
}

export function publishClose(
    raw: unknown,
    destination: string,
    trustedFreeze: TrustedFreeze,
    privacy: PrivacyOptions = {},
): { manifest: CohortCloseManifest; manifestFingerprint: string } {
    privacyFirst(raw, privacy);
    const manifest = parseCloseManifest(raw);
    assertCloseBoundToFreeze(manifest, trustedFreeze, {
        epochId: "close.epochId: freeze-mismatch",
        freezeManifestFingerprint: "close.freezeManifestFingerprint: mismatch",
    });
    writeArtifactAtomically(manifest, destination);
    return loadClose(destination, canonicalFingerprint(manifest), trustedFreeze, privacy);
}

export function loadClose(
    artifactDir: string,
    expectedManifestFingerprint: string,
    trustedFreeze: TrustedFreeze,
    privacy: PrivacyOptions = {},
): { manifest: CohortCloseManifest; manifestFingerprint: string } {
    const raw = readManifest(artifactDir);
    privacyFirst(raw, privacy);
    const manifestFingerprint = canonicalFingerprint(raw);
    if (manifestFingerprint !== expectedManifestFingerprint) {
        throw new HoldoutContractError(["close.manifest: untrusted"]);
    }
    const manifest = parseCloseManifest(raw);
    // One code covers either link field on this path.
    const linkInvalid = "close: freeze-link-invalid";
    assertCloseBoundToFreeze(manifest, trustedFreeze, {
        epochId: linkInvalid,
        freezeManifestFingerprint: linkInvalid,
    });
    return { manifest, manifestFingerprint };
}

export function readTrustedManifestRegistry(path: string): TrustedManifestEntry[] {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        throw new HoldoutContractError(["trust-registry: unreadable"]);
    }
    if (text.length === 0) return [];
    if (!text.endsWith("\n")) throw new HoldoutContractError(["trust-registry: newline-required"]);
    const entries = text.slice(0, -1).split("\n").map((line, index) => {
        let raw: unknown;
        try {
            raw = JSON.parse(line);
        } catch {
            throw new HoldoutContractError([`trust-registry[${index}]: invalid-json`]);
        }
        const entry = parseTrustedManifestEntry(raw, `trust-registry[${index}]`);
        if (canonicalJson(entry) !== line) {
            throw new HoldoutContractError([`trust-registry[${index}]: non-canonical`]);
        }
        return entry;
    });
    const identities = entries.map((entry) => `${entry.epochId}:${entry.kind}:${entry.sequence ?? "manifest"}`);
    if (new Set(identities).size !== identities.length) {
        throw new HoldoutContractError(["trust-registry: duplicate-identity"]);
    }
    const lastLifecycleSequence = new Map<string, number>();
    for (const entry of entries) {
        if (entry.kind !== "lifecycle") continue;
        const previous = lastLifecycleSequence.get(entry.epochId) ?? 0;
        if (entry.sequence! <= previous) {
            throw new HoldoutContractError(["trust-registry: lifecycle-order-invalid"]);
        }
        lastLifecycleSequence.set(entry.epochId, entry.sequence!);
    }
    return entries;
}

export function trustedFingerprint(
    entries: readonly TrustedManifestEntry[],
    epochId: string,
    kind: TrustedManifestEntry["kind"],
): string {
    const entry = entries.find((candidate) =>
        candidate.epochId === epochId && candidate.kind === kind && candidate.sequence === null,
    );
    if (!entry) throw new HoldoutContractError([`trust-registry:${kind}-missing`]);
    return entry.manifestFingerprint;
}

export function validateTrustedLifecycle(
    entries: readonly TrustedManifestEntry[],
    epochId: string,
    events: readonly LifecycleEvent[],
): void {
    const lifecycleEntries = entries.filter((entry) => entry.epochId === epochId && entry.kind === "lifecycle");
    if (lifecycleEntries.length === 0) throw new HoldoutContractError(["trust-registry:lifecycle-missing"]);
    for (const [index, entry] of lifecycleEntries.entries()) {
        const sequence = index + 1;
        if (
            entry.sequence !== sequence ||
            sequence > events.length ||
            canonicalFingerprint(events.slice(0, sequence)) !== entry.manifestFingerprint
        ) {
            throw new HoldoutContractError(["lifecycle: trusted-prefix-mismatch"]);
        }
    }
    if (lifecycleEntries.length !== events.length) {
        throw new HoldoutContractError(["lifecycle: untrusted-suffix"]);
    }
}
