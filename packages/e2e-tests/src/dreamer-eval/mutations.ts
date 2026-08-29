import { isRunFatal } from "./contract";
import type {
    FailReason,
    ParsedLayerGold,
    PoolDescriptor,
} from "./contract";
import {
    scoreClassifyManifest,
    scoreMapManifest,
    scoreVerifyManifest,
    type ManifestScore,
    type ManifestScoreStage,
} from "./scorer";

export const DREAMER_MUTATION_CLASSES = [
    "wrong-archival",
    "missed-archival",
    "update-for-verified",
    "verified-for-update",
    "update-missing-anchor",
    "update-forbidden-anchor",
    "wrong-independence",
    "missing-gold-file",
    "importance-outside-band",
    "wrong-scope",
    "wrong-shareable",
    "truncated-root",
    "missing-id",
    "unknown-id",
    "duplicate-id",
] as const;
export type DreamerMutationClass = (typeof DREAMER_MUTATION_CLASSES)[number];

export interface DreamerMutationFixture {
    pool: PoolDescriptor;
    verifyGold: Extract<ParsedLayerGold, { kind: "verify" }>;
    mapGold: Extract<ParsedLayerGold, { kind: "map" }>;
    classifyGold: Extract<ParsedLayerGold, { kind: "classify" }>;
}

interface ExpectedMutationOutcome {
    stage: Extract<ManifestScoreStage, "validation-rejected" | "scored">;
    reason: FailReason;
}

export const EXPECTED_MUTATION_OUTCOMES: Record<DreamerMutationClass, ExpectedMutationOutcome> = {
    "wrong-archival": { stage: "scored", reason: "wrong-archival" },
    "missed-archival": { stage: "scored", reason: "missed-archival" },
    "update-for-verified": { stage: "scored", reason: "wrong-verdict" },
    "verified-for-update": { stage: "scored", reason: "wrong-verdict" },
    "update-missing-anchor": { stage: "scored", reason: "wrong-update-content" },
    "update-forbidden-anchor": { stage: "scored", reason: "wrong-update-content" },
    "wrong-independence": { stage: "scored", reason: "wrong-independence" },
    "missing-gold-file": { stage: "scored", reason: "wrong-mapping" },
    "importance-outside-band": { stage: "scored", reason: "wrong-classification" },
    "wrong-scope": { stage: "scored", reason: "wrong-classification" },
    "wrong-shareable": { stage: "scored", reason: "wrong-classification" },
    "truncated-root": { stage: "validation-rejected", reason: "invalid-output" },
    "missing-id": { stage: "validation-rejected", reason: "invalid-output" },
    "unknown-id": { stage: "validation-rejected", reason: "invalid-output" },
    "duplicate-id": { stage: "validation-rejected", reason: "invalid-output" },
};

export interface MutationResult {
    mutationClass: DreamerMutationClass;
    green: boolean;
    actualStage: ManifestScoreStage;
    actualReason: ManifestScore["reason"];
    runFatal: boolean;
}

export interface MutationEvidence {
    green: boolean;
    results: MutationResult[];
}

function claimById(pool: PoolDescriptor, claimId: string) {
    const claim = pool.claims.find((entry) => entry.claimId === claimId);
    if (claim === undefined) throw new Error(`mutation fixture gold references missing claim ${claimId}`);
    return claim;
}

function correctVerifyManifest(fixture: DreamerMutationFixture): string {
    const entries = fixture.verifyGold.claims.map((gold) => {
        const claim = claimById(fixture.pool, gold.claimId);
        if (gold.verdict === "verified") {
            return `<verified claim="${claim.publicClaimId}" files="${gold.expectedFiles.join(",")}"/>`;
        }
        if (gold.verdict === "archive") return `<archive claim="${claim.publicClaimId}" reason="contradicted"/>`;
        return `<update claim="${claim.publicClaimId}" files="${gold.expectedFiles.join(",")}">${gold.requiredUpdateAnchors.join("; ")}</update>`;
    });
    return `<verify>\n${entries.join("\n")}\n</verify>`;
}

function correctMapManifest(fixture: DreamerMutationFixture): string {
    const entries = fixture.mapGold.claims.map((gold) => {
        const claim = claimById(fixture.pool, gold.claimId);
        return gold.independent
            ? `<memory claim="${claim.publicClaimId}" independent="true"/>`
            : `<memory claim="${claim.publicClaimId}" files="${gold.files.join(",")}"/>`;
    });
    return `<mappings>\n${entries.join("\n")}\n</mappings>`;
}

function correctClassifyManifest(fixture: DreamerMutationFixture): string {
    const entries = fixture.classifyGold.claims.map((gold) => {
        const claim = claimById(fixture.pool, gold.claimId);
        return `<memory claim="${claim.publicClaimId}" importance="${gold.importance.min}" scope="${gold.scope}" shareable="${gold.shareable}"/>`;
    });
    return `<classify>\n${entries.join("\n")}\n</classify>`;
}

function requiredGold<T>(items: readonly T[], predicate: (item: T) => boolean, description: string): T {
    const item = items.find(predicate);
    if (item === undefined) throw new Error(`mutation fixture needs ${description}`);
    return item;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceEntry(manifest: string, publicClaimId: string, replacement: string): string {
    const escaped = escapeRegExp(publicClaimId);
    const pattern = new RegExp(`<(?:verified|archive)\\b[^>]*claim="${escaped}"[^>]*/>|<update\\b[^>]*claim="${escaped}"[^>]*>[\\s\\S]*?</update>`);
    const changed = manifest.replace(pattern, replacement);
    if (changed === manifest) throw new Error(`mutation fixture could not replace verify entry ${publicClaimId}`);
    return changed;
}

/**
 * Rewrites one claim's `files` attribute in a mappings manifest. Scoping to the
 * claim id matters because claims may declare identical file sets, and an
 * unscoped match rewrites whichever entry appears first rather than the one the
 * mutation class selected.
 */
function replaceMapFiles(manifest: string, publicClaimId: string, files: readonly string[]): string {
    const pattern = new RegExp(`(<memory\\b[^>]*claim="${escapeRegExp(publicClaimId)}"[^>]*files=")[^"]*(")`);
    const changed = manifest.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${files.join(",")}${suffix}`);
    if (changed === manifest) throw new Error(`mutation fixture could not replace map files for ${publicClaimId}`);
    return changed;
}

function mutationManifest(
    mutationClass: DreamerMutationClass,
    fixture: DreamerMutationFixture,
    verify: string,
    map: string,
    classify: string,
): { task: "verify" | "map" | "classify"; manifest: string } {
    const verified = requiredGold(fixture.verifyGold.claims, (entry) => entry.verdict === "verified", "verified gold");
    const updated = requiredGold(fixture.verifyGold.claims, (entry) => entry.verdict === "update", "update gold");
    const archived = requiredGold(fixture.verifyGold.claims, (entry) => entry.verdict === "archive", "archive gold");
    const verifiedClaim = claimById(fixture.pool, verified.claimId);
    const updatedClaim = claimById(fixture.pool, updated.claimId);
    const archivedClaim = claimById(fixture.pool, archived.claimId);

    switch (mutationClass) {
        case "wrong-archival":
            return { task: "verify", manifest: replaceEntry(verify, verifiedClaim.publicClaimId, `<archive claim="${verifiedClaim.publicClaimId}" reason="wrong"/>`) };
        case "missed-archival": {
            // A backing set is required whenever the manifest retains a claim,
            // so an archived claim carrying no mapping needs a stand-in here:
            // an empty attribute would be rejected as invalid output before the
            // scorer could observe the missed archival this class exercises.
            const files = archivedClaim.files.length > 0 ? archivedClaim.files : ["mutation/retained.ts"];
            return { task: "verify", manifest: replaceEntry(verify, archivedClaim.publicClaimId, `<verified claim="${archivedClaim.publicClaimId}" files="${files.join(",")}"/>`) };
        }
        case "update-for-verified":
            return { task: "verify", manifest: replaceEntry(verify, verifiedClaim.publicClaimId, `<update claim="${verifiedClaim.publicClaimId}" files="${verifiedClaim.files.join(",")}">still true</update>`) };
        case "verified-for-update":
            return { task: "verify", manifest: replaceEntry(verify, updatedClaim.publicClaimId, `<verified claim="${updatedClaim.publicClaimId}" files="${updatedClaim.files.join(",")}"/>`) };
        case "update-missing-anchor":
            return { task: "verify", manifest: replaceEntry(verify, updatedClaim.publicClaimId, `<update claim="${updatedClaim.publicClaimId}" files="${updated.expectedFiles.join(",")}">replacement omits required facts</update>`) };
        case "update-forbidden-anchor": {
            const forbidden = updated.forbiddenUpdateAnchors[0];
            if (forbidden === undefined) throw new Error("mutation fixture needs forbidden update anchor");
            const content = [...updated.requiredUpdateAnchors, forbidden].join("; ");
            return { task: "verify", manifest: replaceEntry(verify, updatedClaim.publicClaimId, `<update claim="${updatedClaim.publicClaimId}" files="${updated.expectedFiles.join(",")}">${content}</update>`) };
        }
        case "wrong-independence": {
            const target = requiredGold(fixture.mapGold.claims, (entry) => !entry.independent, "file-bound map gold");
            const claim = claimById(fixture.pool, target.claimId);
            return { task: "map", manifest: map.replace(new RegExp(`<memory\\b[^>]*claim="${escapeRegExp(claim.publicClaimId)}"[^>]*/>`), `<memory claim="${claim.publicClaimId}" independent="true"/>`) };
        }
        case "missing-gold-file": {
            const target = requiredGold(fixture.mapGold.claims, (entry) => !entry.independent && entry.files.length > 0, "mapped gold file");
            const claim = claimById(fixture.pool, target.claimId);
            const remaining = target.files.length > 1 ? target.files.slice(1) : ["mutation/other.ts"];
            return { task: "map", manifest: replaceMapFiles(map, claim.publicClaimId, remaining) };
        }
        case "importance-outside-band": {
            const target = requiredGold(fixture.classifyGold.claims, (entry) => entry.importance.min > 1 || entry.importance.max < 100, "non-total importance band");
            const claim = claimById(fixture.pool, target.claimId);
            const outside = target.importance.min > 1 ? target.importance.min - 1 : target.importance.max + 1;
            return { task: "classify", manifest: classify.replace(new RegExp(`(claim="${escapeRegExp(claim.publicClaimId)}"[^>]*importance=")\\d+`), `$1${outside}`) };
        }
        case "wrong-scope": {
            const target = fixture.classifyGold.claims[0];
            if (target === undefined) throw new Error("mutation fixture needs classify gold");
            const claim = claimById(fixture.pool, target.claimId);
            const wrong = target.scope === "project" ? "ecosystem" : "project";
            return { task: "classify", manifest: classify.replace(new RegExp(`(claim="${escapeRegExp(claim.publicClaimId)}"[^>]*scope=")${target.scope}`), `$1${wrong}`) };
        }
        case "wrong-shareable": {
            const target = fixture.classifyGold.claims[0];
            if (target === undefined) throw new Error("mutation fixture needs classify gold");
            const claim = claimById(fixture.pool, target.claimId);
            return { task: "classify", manifest: classify.replace(new RegExp(`(claim="${escapeRegExp(claim.publicClaimId)}"[^>]*shareable=")${target.shareable}`), `$1${!target.shareable}`) };
        }
        case "truncated-root":
            return { task: "verify", manifest: verify.replace("</verify>", "") };
        case "missing-id":
            return { task: "verify", manifest: verify.replace(` claim="${verifiedClaim.publicClaimId}"`, "") };
        case "unknown-id":
            return { task: "verify", manifest: verify.replace(verifiedClaim.publicClaimId, "mcm_unknown") };
        case "duplicate-id":
            return { task: "verify", manifest: verify.replace("</verify>", `<verified claim="${verifiedClaim.publicClaimId}" files="${verifiedClaim.files.join(",")}"/>\n</verify>`) };
    }
}

function scoreMutation(
    task: "verify" | "map" | "classify",
    manifest: string,
    fixture: DreamerMutationFixture,
): ManifestScore {
    if (task === "verify") return scoreVerifyManifest(manifest, fixture.pool, fixture.verifyGold);
    if (task === "map") return scoreMapManifest(manifest, fixture.pool, fixture.mapGold);
    return scoreClassifyManifest(manifest, fixture.pool, fixture.classifyGold);
}

export function runMutationBattery(
    fixture: DreamerMutationFixture,
    overrides: Partial<Record<DreamerMutationClass, string>> = {},
): MutationEvidence {
    const verify = correctVerifyManifest(fixture);
    const map = correctMapManifest(fixture);
    const classify = correctClassifyManifest(fixture);
    const baselines = [
        scoreVerifyManifest(verify, fixture.pool, fixture.verifyGold),
        scoreMapManifest(map, fixture.pool, fixture.mapGold),
        scoreClassifyManifest(classify, fixture.pool, fixture.classifyGold),
    ];
    if (baselines.some((baseline) => baseline.status !== "PASS")) {
        throw new Error("mutation fixture baseline must pass all scorers");
    }

    const results = DREAMER_MUTATION_CLASSES.map((mutationClass): MutationResult => {
        const mutation = mutationManifest(mutationClass, fixture, verify, map, classify);
        const result = scoreMutation(mutation.task, overrides[mutationClass] ?? mutation.manifest, fixture);
        const expected = EXPECTED_MUTATION_OUTCOMES[mutationClass];
        const green =
            result.stage === expected.stage &&
            result.status === "FAIL" &&
            result.reason === expected.reason &&
            result.runFatal === isRunFatal("FAIL", expected.reason);
        return {
            mutationClass,
            green,
            actualStage: result.stage,
            actualReason: result.reason,
            runFatal: result.runFatal,
        };
    });
    return { green: results.every((result) => result.green), results };
}
