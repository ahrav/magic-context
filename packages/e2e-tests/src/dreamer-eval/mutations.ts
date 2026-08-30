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
 * Characters a filler is never drawn from: whitespace would be trimmed away, and
 * these five change how a manifest is split or parsed.
 */
const FILLER_EXCLUDED = new Set(["<", ">", "&", '"', ","]);

/**
 * Filler candidates, widest first: printable ASCII, then Latin-1 and Latin
 * Extended letters. Roughly 480 distinct characters, so exhausting the domain
 * takes a fixture that names that many distinct characters among its forbidden
 * anchors. That is not literally unbounded — no fixed alphabet can be — but a
 * fixture reaching it gets a named error rather than a wrong baseline, because
 * every caller verifies the content it builds.
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
 * A character present in none of `phrases`. Anchor checks are case-insensitive
 * substring tests, so a string built only from this character contains no
 * phrase, and any substring spanning it cannot match one either.
 */
function fillerAbsentFrom(phrases: readonly string[], description: string): string {
    const used = new Set<string>();
    for (const phrase of phrases) {
        for (const character of phrase.toLowerCase()) used.add(character);
    }
    for (const candidate of fillerCandidates()) {
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error(`mutation fixture needs ${description}`);
}

/**
 * Update content that carries every required anchor, no forbidden one, and fits
 * the production content cap.
 *
 * The contract rejects a forbidden anchor contained in a single required anchor
 * but not one spanning their join: required `alpha` and `beta` with forbidden
 * `alpha; beta` validates, yet the delimiter-joined baseline would contain the
 * forbidden phrase and fail scoring, making `runMutationBattery` throw on its
 * own supposedly-correct baseline. A separator holding a character absent from
 * every forbidden anchor makes a spanning match impossible.
 *
 * The contract also caps each individual anchor, which is the length it can
 * prove unsatisfiable, but anchors may overlap inside one body so it cannot
 * reject a combined length. This construction does not exploit that overlap, so
 * a fixture whose anchors only fit when interleaved gets a named error here
 * rather than the opaque "baseline must pass all scorers".
 */
/**
 * Update content that carries every required anchor, no forbidden one, fits the
 * production content cap, and takes an identity no other live claim holds —
 * including one an earlier update in this same batch just took.
 *
 * The contract rejects a forbidden anchor contained in a single required anchor
 * but not one spanning their join: required `alpha` and `beta` with forbidden
 * `alpha; beta` validates, yet the delimiter-joined baseline would contain the
 * forbidden phrase and fail scoring, making `runMutationBattery` throw on its
 * own supposedly-correct baseline. A separator holding a character absent from
 * every forbidden anchor makes a spanning match impossible.
 *
 * The contract also caps each individual anchor, which is the length it can
 * prove unsatisfiable, but anchors may overlap inside one body so it cannot
 * reject a combined length. This construction does not exploit that overlap, so
 * a fixture whose anchors only fit when interleaved gets a named error here
 * rather than the opaque "baseline must pass all scorers".
 *
 * `ledger` carries the identities already spoken for and is updated in place, so
 * two updates whose anchors generate the same body do not silently converge on
 * one identity — which the scorer would reject as unappliable on the second.
 */
function passingUpdateContent(
    fixture: DreamerMutationFixture,
    gold: VerifyGoldClaim,
    ledger: Map<string, string>,
): string {
    const claim = claimById(fixture.pool, gold.claimId);
    // The revision vacates whatever this claim held, matching the exemption
    // production grants a claim against its own identity.
    ledger.delete(claimIdentity(claim.category, claim.content));
    let content = buildUpdateContent(gold);
    // Padding shifts the normalized identity while keeping every anchor present,
    // which is what makes such a fixture satisfiable rather than broken. Each pad
    // appends a distinct suffix and the ledger is finite, so a free identity
    // arrives within `ledger.size + 1` attempts; the content cap is the real
    // limit, and it is checked below.
    for (let attempt = 0; attempt <= ledger.size && ledger.has(claimIdentity(claim.category, content)); attempt += 1) {
        const filler = fillerAbsentFrom(
            gold.forbiddenUpdateAnchors,
            "a pad character absent from every forbidden update anchor",
        );
        // Spend only what the cap leaves: a body one character short of the limit
        // is still separable, so a two-character suffix would refuse a fixture a
        // one-character one satisfies.
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
        // Production refuses an empty replacement body, so the baseline still
        // needs content when the gold requires no anchor.
        return fillerAbsentFrom(
            gold.forbiddenUpdateAnchors,
            "a filler character absent from every forbidden update anchor",
        ).repeat(3);
    }
    const joined = gold.requiredUpdateAnchors.join("; ");
    if (!containsAny(joined, gold.forbiddenUpdateAnchors)) return padEdgeWhitespace(joined, gold);
    const filler = fillerAbsentFrom(
        gold.forbiddenUpdateAnchors,
        "a separator absent from every forbidden update anchor",
    );
    const spaced = gold.requiredUpdateAnchors.join(` ${filler} `);
    if (containsAny(spaced, gold.forbiddenUpdateAnchors)) {
        throw new Error("mutation fixture needs update anchors joinable without a forbidden phrase");
    }
    return padEdgeWhitespace(spaced, gold);
}

/**
 * Keeps an anchor's own edge whitespace inside the body. `parseVerifyManifest`
 * trims the body before the scorer runs, so an anchor like `" alpha "` sitting at
 * the outer edge loses its spaces and the supposedly correct baseline fails —
 * even though such gold is satisfiable by placing the anchor inside other
 * content. The pad is a character absent from every forbidden anchor, so it
 * cannot introduce one, and untouched gold keeps its exact former bytes.
 */
function padEdgeWhitespace(content: string, gold: VerifyGoldClaim): string {
    const needsLeading = gold.requiredUpdateAnchors.some((anchor) => /^\s/.test(anchor));
    const needsTrailing = gold.requiredUpdateAnchors.some((anchor) => /\s$/.test(anchor));
    if (!needsLeading && !needsTrailing) return content;
    // Pad each side independently: the contract charges an anchor only for the
    // edges it actually holds whitespace on, so padding the other side too would
    // refuse a fixture that just fits.
    const pad = fillerAbsentFrom(
        gold.forbiddenUpdateAnchors,
        "a pad character absent from every forbidden update anchor",
    );
    return `${needsLeading ? pad : ""}${content}${needsTrailing ? pad : ""}`;
}

/**
 * A path outside `files`. Among `files.length + 1` distinct candidates at least
 * one cannot collide, so the loop always returns.
 */
function pathAbsentFrom(files: readonly string[]): string {
    for (let index = 0; index <= files.length; index += 1) {
        const candidate = index === 0 ? "mutation/other.ts" : `mutation/other-${index}.ts`;
        if (!files.includes(candidate)) return candidate;
    }
    throw new Error("mutation fixture could not synthesize a path absent from the map gold");
}

function correctVerifyManifest(fixture: DreamerMutationFixture): string {
    // One ledger for the whole manifest: production stages these updates in this
    // order, and each takes its identity for the rest of the batch.
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
        // Reporting `shareable="true"` for sensitive content is forced back to
        // false, so gold expecting it to stay shareable is reachable only by
        // omitting the attribute and letting the stored value stand. The parser
        // requires at least one classification field, which importance and scope
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
    // A callback keeps the replacement bytes literal. Passing the string form
    // lets `$&`, `$1`, or a backtick token inside an authored anchor expand into
    // the matched entry, so the mutation would carry content nobody wrote — and
    // for the forbidden-anchor case the forbidden phrase would vanish from it
    // and the mutation could score PASS.
    const changed = manifest.replace(pattern, () => replacement);
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

/**
 * Constructs the parser treats as an entry boundary, matched case-sensitively
 * because every one of the parser's own regexes is.
 */
const PARSER_ACTIVE_RE = /<\/?(?:verified|update|archive)\b/;

/**
 * A spelling of `anchor` that can sit inside an update body, or null when none
 * can.
 *
 * The forbidden check is case-insensitive while the entry regexes are not, so
 * raising an entry construct's case keeps the anchor matchable while making it
 * inert to the parser. The root close tag has no such escape: the body extraction
 * folds case, so any spelling of it truncates the body and no equivalent
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
        case "update-missing-anchor": {
            // The mutation has to actually omit a required anchor, so it needs
            // an update gold that has one: with none, any replacement is valid
            // content and the case would score PASS. A fixed sentence is not
            // enough either — ordinary anchors such as `required` or `facts`
            // occur in it and score PASS the same way. Content built from a
            // character absent from every anchor provably omits all of them.
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
            // Read the gold that actually carries an embeddable forbidden anchor
            // rather than the first update: a fixture whose first update has none
            // but whose later one does has everything this class needs, and
            // taking the first would abort the whole battery. Embeddability
            // matters because a forbidden anchor spelling an entry boundary would
            // end the entry before the scorer could observe it.
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
            const content = [...target.requiredUpdateAnchors, forbidden].join("; ");
            return { task: "verify", manifest: replaceEntry(verify, claim.publicClaimId, `<update claim="${claim.publicClaimId}" files="${target.expectedFiles.join(",")}">${content}</update>`) };
        }
        case "wrong-independence": {
            // Either direction is a wrong independence claim, so an all-independent
            // map gold is mutable too: replacing an independent entry with one
            // carrying files parses as file-bound. Requiring a file-bound target
            // would abort the battery on a contract-valid fixture.
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
            // Dropping the first path is the mutation. A single-file gold has
            // nothing to drop, so it needs a stand-in the gold does not already
            // name — otherwise `replaceMapFiles` sees no textual change and
            // throws instead of producing the mutation.
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
            // Two usable shapes. Non-sensitive content lets the emitted attribute
            // be flipped either way. Sensitive content with `true` gold has no
            // emitted attribute — the baseline omits it so the stored value is
            // preserved — so the mutation inserts `shareable="false"`, which
            // changes the applied value. Only sensitive content with `false` gold
            // is unusable: the attribute is emitted, and flipping it to `true` is
            // rescued by the override, leaving the applied value equal to gold.
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
