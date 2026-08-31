import { VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { hasShareabilitySensitiveText } from "../../../plugin/src/shared/redaction";
import { isRunFatal } from "./contract";
import type {
    FailReason,
    ParsedLayerGold,
    PoolDescriptor,
    VerifyGoldClaim,
} from "./contract";
import {
    scoreClassifyManifest,
    scoreMapManifest,
    scoreVerifyManifest,
    claimIdentity,
    liveIdentities,
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

/**
 * Whitespace is excluded because trimming removes it.
 */
const FILLER_EXCLUDED = new Set(["<", ">", "&", '"', ","]);

/**
 */
function* fillerCandidates(): Generator<string> {
    for (const [start, end] of [
        [0x21, 0x7e],
        [0xc0, 0x24f],
    ] as const) {
        for (let code = start; code <= end; code += 1) {
            const candidate = String.fromCodePoint(code);
            if (FILLER_EXCLUDED.has(candidate) || candidate.trim() === "") continue;
            yield candidate;
        }
    }
}

function containsAny(content: string, phrases: readonly string[]): boolean {
    const lowered = content.toLowerCase();
    return phrases.some((phrase) => lowered.includes(phrase.toLowerCase()));
}

/**
 *
 * The function compares complete lowercase strings because `toLowerCase()` can expand one character into multiple code units.
 */
function fillerAbsentFrom(phrases: readonly string[], description: string): string {
    const lowered = phrases.map((phrase) => phrase.toLowerCase());
    for (const candidate of fillerCandidates()) {
        const folded = candidate.toLowerCase();
        if (!lowered.some((phrase) => phrase.includes(folded) || folded.includes(phrase))) {
            return candidate;
        }
    }
    throw new Error(`mutation fixture needs ${description}`);
}

/**
 * `buildUpdateContent` returns content containing every required anchor, excluding every forbidden anchor, and fitting the production cap.
 *
 * Required `alpha` and `beta` may coexist with forbidden `alpha; beta` because the forbidden anchor spans their join.
 * A delimiter-joined baseline would contain that forbidden phrase and make `runMutationBattery` reject its baseline.
 *
 * Production caps each anchor individually, although overlapping anchors can fit in one body.
 */
/**
 * `passingUpdateContent` assigns an identity that no live claim holds, including identities assigned by earlier updates in the batch.
 *
 * Validation checks required anchors independently, so a forbidden phrase can span joined anchors; the separator uses a character absent from every forbidden anchor to prevent spanning matches.
 *
 * `passingUpdateContent` rejects fixtures that fit only through overlapping anchors.
 *
 * `ledger` records identities claimed by earlier updates so later updates avoid them.
 */
function passingUpdateContent(
    fixture: DreamerMutationFixture,
    gold: VerifyGoldClaim,
    ledger: Map<string, string>,
): string {
    const claim = claimById(fixture.pool, gold.claimId);
    // Deleting `claim`'s current identity lets its update retain that identity, as production permits.
    ledger.delete(claimIdentity(claim.category, claim.content));
    let content = buildUpdateContent(gold);
    // Each padding attempt appends a suffix; a fixed finite `ledger` yields a free identity within `ledger.size + 1` attempts unless the content cap prevents it.
    for (let attempt = 0; attempt <= ledger.size && ledger.has(claimIdentity(claim.category, content)); attempt += 1) {
        const filler = fillerAbsentFrom(
            gold.forbiddenUpdateAnchors,
            "a pad character absent from every forbidden update anchor",
        );
        const remaining = VERIFY_UPDATE_CONTENT_MAX_LENGTH - content.length;
        if (remaining <= 0) break;
        content = remaining >= 2 ? `${content} ${filler}` : `${content}${filler}`;
    }
    if (ledger.has(claimIdentity(claim.category, content))) {
        throw new Error("mutation fixture needs update anchors that avoid every live claim identity");
    }
    if (content.length > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
        throw new Error("mutation fixture needs required update anchors that join within the content cap");
    }
    ledger.set(claimIdentity(claim.category, content), claim.publicClaimId);
    return content;
}


function buildUpdateContent(gold: VerifyGoldClaim): string {
    if (gold.requiredUpdateAnchors.length === 0) {
        // Production rejects empty replacement bodies, so anchorless gold needs filler.
        return fillerAbsentFrom(
            gold.forbiddenUpdateAnchors,
            "a filler character absent from every forbidden update anchor",
        ).repeat(3);
    }
    const spellings = gold.requiredUpdateAnchors.map(inertAnchorSpelling);
    const joined = spellings.join("; ");
    if (!containsAny(joined, gold.forbiddenUpdateAnchors)) return padEdgeWhitespace(joined, gold);
    const filler = fillerAbsentFrom(
        gold.forbiddenUpdateAnchors,
        "a separator absent from every forbidden update anchor",
    );
    const spaced = spellings.join(` ${filler} `);
    if (containsAny(spaced, gold.forbiddenUpdateAnchors)) {
        throw new Error("mutation fixture needs update anchors joinable without a forbidden phrase");
    }
    return padEdgeWhitespace(spaced, gold);
}

/**
 * `buildUpdateContent` pads edge-whitespace anchors so manifest trimming preserves each anchor.
 * `buildUpdateContent` uses padding absent from every forbidden anchor to prevent padding from creating a forbidden match.
 * `buildUpdateContent` preserves unmodified anchor bytes when padding is unnecessary.
 */
function padEdgeWhitespace(content: string, gold: VerifyGoldClaim): string {
    const needsLeading = gold.requiredUpdateAnchors.some((anchor) => /^\s/.test(anchor));
    const needsTrailing = gold.requiredUpdateAnchors.some((anchor) => /\s$/.test(anchor));
    if (!needsLeading && !needsTrailing) return content;
    // `buildUpdateContent` pads only anchor edges containing whitespace; padding both edges can reject a fixture that exactly fits.
    const pad = fillerAbsentFrom(
        gold.forbiddenUpdateAnchors,
        "a pad character absent from every forbidden update anchor",
    );
    return `${needsLeading ? pad : ""}${content}${needsTrailing ? pad : ""}`;
}

/**
 * `files.length + 1` distinct candidates guarantee one path outside `files`, so the loop always returns.
 */
function pathAbsentFrom(files: readonly string[]): string {
    for (let index = 0; index <= files.length; index += 1) {
        const candidate = index === 0 ? "mutation/other.ts" : `mutation/other-${index}.ts`;
        if (!files.includes(candidate)) return candidate;
    }
    throw new Error("mutation fixture could not synthesize a path absent from the map gold");
}

function correctVerifyManifest(fixture: DreamerMutationFixture): string {
    // `ledger` spans the manifest because production stages updates in order and reserves each identity for the rest of the batch.
    const ledger = liveIdentities(fixture.pool);
    const entries = fixture.verifyGold.claims.map((gold) => {
        const claim = claimById(fixture.pool, gold.claimId);
        if (gold.verdict === "verified") {
            return `<verified claim="${claim.publicClaimId}" files="${gold.expectedFiles.join(",")}"/>`;
        }
        if (gold.verdict === "archive") return `<archive claim="${claim.publicClaimId}" reason="contradicted"/>`;
        return `<update claim="${claim.publicClaimId}" files="${gold.expectedFiles.join(",")}">${passingUpdateContent(fixture, gold, ledger)}</update>`;
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
        const attributes = `importance="${gold.importance.min}" scope="${gold.scope}"`;
        // Sensitive content with `shareable="true"` is stored as `false`; gold can expect the existing shareable value only when the attribute is omitted.
        // The request requires at least one classification field; `importance` and `scope` satisfy that requirement.
        // supply.
        if (gold.shareable && hasShareabilitySensitiveText(claim.content)) {
            return `<memory claim="${claim.publicClaimId}" ${attributes}/>`;
        }
        return `<memory claim="${claim.publicClaimId}" ${attributes} shareable="${gold.shareable}"/>`;
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
    // The callback keeps replacement bytes literal.
    // String replacement expands `$&`, `$1`, and backtick tokens in authored anchors.
    // String replacement expansion can inject matched content into the mutation.
    // Expansion can remove the forbidden phrase and let the mutation score PASS.
    const changed = manifest.replace(pattern, () => replacement);
    if (changed === manifest) throw new Error(`mutation fixture could not replace verify entry ${publicClaimId}`);
    return changed;
}

/**
 * Claims can share file sets, so matching by files alone can rewrite the first matching entry instead of `publicClaimId`.
 */
function replaceMapFiles(manifest: string, publicClaimId: string, files: readonly string[]): string {
    const pattern = new RegExp(`(<memory\\b[^>]*claim="${escapeRegExp(publicClaimId)}"[^>]*files=")[^"]*(")`);
    const changed = manifest.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${files.join(",")}${suffix}`);
    if (changed === manifest) throw new Error(`mutation fixture could not replace map files for ${publicClaimId}`);
    return changed;
}

/**
 */
const PARSER_ACTIVE_RE = /<\/?(?:verified|update|archive)\b/;

/**
 * Uppercasing entry constructs makes them inert to case-sensitive parser regexes while preserving a case-folded anchor match.
 * The embedding helper throws when only `</verify>` prevents embedding the anchor.
 */
function inertAnchorSpelling(anchor: string): string {
    const spelling = embeddableForbiddenAnchor(anchor);
    if (spelling === null) {
        throw new Error("mutation fixture needs update anchors that can appear in an update body");
    }
    return spelling;
}

/**
 * can.
 *
 * Case-insensitive forbidden matching recognizes uppercased entry tags, while case-sensitive entry regexes ignore them.
 * `</verify>` cannot be embedded because case-folded body extraction treats every spelling as its closing tag.
 * survives.
 */
function embeddableForbiddenAnchor(anchor: string): string | null {
    if (/<\/verify>/i.test(anchor)) return null;
    if (!PARSER_ACTIVE_RE.test(anchor)) return anchor;
    const raised = anchor.replace(/<\/?(?:verified|update|archive)\b/g, (match) => match.toUpperCase());
    return PARSER_ACTIVE_RE.test(raised) ? null : raised;
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
            const files = archivedClaim.files.length > 0 ? archivedClaim.files : ["mutation/retained.ts"];
            return { task: "verify", manifest: replaceEntry(verify, archivedClaim.publicClaimId, `<verified claim="${archivedClaim.publicClaimId}" files="${files.join(",")}"/>`) };
        }
        case "update-for-verified":
            return { task: "verify", manifest: replaceEntry(verify, verifiedClaim.publicClaimId, `<update claim="${verifiedClaim.publicClaimId}" files="${verifiedClaim.files.join(",")}">still true</update>`) };
        case "verified-for-update":
            return { task: "verify", manifest: replaceEntry(verify, updatedClaim.publicClaimId, `<verified claim="${updatedClaim.publicClaimId}" files="${updatedClaim.files.join(",")}"/>`) };
        case "update-missing-anchor": {
            // `runMutationBattery` accepts updates that omit a required anchor.
            // A fixed sentence may contain a required anchor and pass.
            // A character absent from every anchor omits all anchors.
            const target = requiredGold(
                fixture.verifyGold.claims,
                (entry) => entry.verdict === "update" && entry.requiredUpdateAnchors.length > 0,
                "an update gold with a required anchor",
            );
            const claim = claimById(fixture.pool, target.claimId);
            const content = fillerAbsentFrom(
                [...target.requiredUpdateAnchors, ...target.forbiddenUpdateAnchors],
                "a filler character absent from every update anchor",
            ).repeat(3);
            return { task: "verify", manifest: replaceEntry(verify, claim.publicClaimId, `<update claim="${claim.publicClaimId}" files="${target.expectedFiles.join(",")}">${content}</update>`) };
        }
        case "update-forbidden-anchor": {
            // The first update must not contain a forbidden anchor.
            // The forbidden anchor must not terminate the update entry.
            // An entry-boundary anchor terminates the entry before scoring.
            const target = requiredGold(
                fixture.verifyGold.claims,
                (entry) =>
                    entry.verdict === "update" &&
                    entry.forbiddenUpdateAnchors.some((anchor) => embeddableForbiddenAnchor(anchor) !== null),
                "an update gold with a forbidden anchor that can appear in an update body",
            );
            const claim = claimById(fixture.pool, target.claimId);
            const forbidden = target.forbiddenUpdateAnchors
                .map((anchor) => embeddableForbiddenAnchor(anchor))
                .find((anchor): anchor is string => anchor !== null)!;
            const content = [...target.requiredUpdateAnchors.map(inertAnchorSpelling), forbidden].join("; ");
            return { task: "verify", manifest: replaceEntry(verify, claim.publicClaimId, `<update claim="${claim.publicClaimId}" files="${target.expectedFiles.join(",")}">${content}</update>`) };
        }
        case "wrong-independence": {
            // Changing an independent entry to file-bound, or vice versa, is a wrong independence claim.
            // An all-independent map can be mutated by adding files to one entry.
            // Adding files makes an independent entry file-bound.
            const target = requiredGold(fixture.mapGold.claims, () => true, "map gold");
            const claim = claimById(fixture.pool, target.claimId);
            const flipped = target.independent
                ? `<memory claim="${claim.publicClaimId}" files="${pathAbsentFrom([])}"/>`
                : `<memory claim="${claim.publicClaimId}" independent="true"/>`;
            return { task: "map", manifest: map.replace(new RegExp(`<memory\\b[^>]*claim="${escapeRegExp(claim.publicClaimId)}"[^>]*/>`), () => flipped) };
        }
        case "missing-gold-file": {
            const target = requiredGold(fixture.mapGold.claims, (entry) => !entry.independent && entry.files.length > 0, "mapped gold file");
            const claim = claimById(fixture.pool, target.claimId);
            // A replacement path absent from `target.files` changes a single-file gold's file mapping.
            const remaining = target.files.length > 1 ? target.files.slice(1) : [pathAbsentFrom(target.files)];
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
            // Sensitive content with a `true` gold value omits `shareable`.
            // Omitting `shareable` preserves the stored value.
            // The mutation inserts `shareable="false"` to change a `true` stored value.
            // `shareable` flips cannot mutate sensitive content with a `false` gold value.
            // Flipping an emitted `shareable` value to `true` does not change the applied value.
            const target = requiredGold(
                fixture.classifyGold.claims,
                (entry) =>
                    entry.shareable ||
                    !hasShareabilitySensitiveText(claimById(fixture.pool, entry.claimId).content),
                "a classify gold whose flipped shareability survives the production override",
            );
            const claim = claimById(fixture.pool, target.claimId);
            const omitted = target.shareable && hasShareabilitySensitiveText(claim.content);
            const pattern = omitted
                ? new RegExp(`(<memory claim="${escapeRegExp(claim.publicClaimId)}"[^>]*)(/>)`)
                : new RegExp(`(claim="${escapeRegExp(claim.publicClaimId)}"[^>]*shareable=")${target.shareable}`);
            const replacement = omitted
                ? (_match: string, head: string) => `${head} shareable="false"/>`
                : (_match: string, head: string) => `${head}${!target.shareable}`;
            return { task: "classify", manifest: classify.replace(pattern, replacement) };
        }
        case "truncated-root":
            return { task: "verify", manifest: verify.replace("</verify>", "") };
        case "missing-id":
            return { task: "verify", manifest: verify.replace(` claim="${verifiedClaim.publicClaimId}"`, "") };
        case "unknown-id":
            return { task: "verify", manifest: verify.replace(verifiedClaim.publicClaimId, "mcm_unknown") };
        case "duplicate-id":
            return { task: "verify", manifest: verify.replace("</verify>", () => `<verified claim="${verifiedClaim.publicClaimId}" files="${verifiedClaim.files.join(",")}"/>\n</verify>`) };
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
