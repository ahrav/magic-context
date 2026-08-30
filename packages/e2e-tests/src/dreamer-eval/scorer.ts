import { sep } from "node:path";

import { hasLengthCappedOutput } from "../../../plugin/src/shared/assistant-message-extractor";
import { normalizeMemoryContent } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { hasShareabilitySensitiveText } from "../../../plugin/src/shared/redaction";
import {
    providerOutputFailureFromInvalidManifest,
} from "../../../plugin/src/features/magic-context/dreamer/provider-output-failure";
import { validateClassifyManifest } from "../../../plugin/src/features/magic-context/dreamer/classify-prompt";
import { validateMapMemoriesManifest } from "../../../plugin/src/features/magic-context/dreamer/map-memories-prompt";
import { validateVerifyManifest } from "../../../plugin/src/features/magic-context/dreamer/verify-prompt";
import { VERIFY_UPDATE_CONTENT_MAX_LENGTH } from "../../../plugin/src/features/magic-context/dreamer/verify";
import { isRunFatal, sameSet } from "./contract";
import type {
    ErrorReason,
    FailReason,
    ParsedLayerGold,
    ParsedManifestEvidence,
    PoolDescriptor,
} from "./contract";

export type ManifestScoreStage = "infra-rejected" | "validation-rejected" | "scored";

export interface ManifestScore {
    stage: ManifestScoreStage;
    status: "PASS" | "FAIL" | "ERROR";
    reason: ErrorReason | FailReason | null;
    runFatal: boolean;
    /**
     * Evidence in the shape the report contract accepts, so a score can be
     * carried into a run report without a wrapper transformation.
     */
    parsedManifest: ParsedManifestEvidence | null;
}

export interface ManifestInfraEvidence {
    messages: unknown;
}

interface ScoringContext {
    expectedIds: Set<string>;
    byClaimId: Map<string, { publicClaimId: string; files: string[] }>;
}

type VerifyGold = Extract<ParsedLayerGold, { kind: "verify" }>;
type MapGold = Extract<ParsedLayerGold, { kind: "map" }>;
type ClassifyGold = Extract<ParsedLayerGold, { kind: "classify" }>;

function score(status: ManifestScore["status"], reason: ManifestScore["reason"], stage: ManifestScoreStage, parsedManifest: ParsedManifestEvidence | null = null): ManifestScore {
    return {
        stage,
        status,
        reason,
        runFatal: isRunFatal(status, reason),
        parsedManifest,
    };
}

function scoringContext<Gold extends { claimId: string }>(
    pool: PoolDescriptor,
    gold: readonly Gold[],
): ScoringContext | ManifestScore {
    const poolByClaimId = new Map(pool.claims.map((claim) => [claim.claimId, claim]));
    const byClaimId = new Map<string, { publicClaimId: string; files: string[] }>();
    for (const entry of gold) {
        const claim = poolByClaimId.get(entry.claimId);
        if (claim === undefined) return score("ERROR", "harness-failure", "infra-rejected");
        byClaimId.set(entry.claimId, { publicClaimId: claim.publicClaimId, files: claim.files });
    }
    return {
        expectedIds: new Set([...byClaimId.values()].map((claim) => claim.publicClaimId)),
        byClaimId,
    };
}

function isScore(value: ScoringContext | ManifestScore): value is ManifestScore {
    return "stage" in value;
}

function precheck(manifestText: string, evidence?: ManifestInfraEvidence): ManifestScore | null {
    if (evidence !== undefined && hasLengthCappedOutput(evidence.messages)) {
        return score("ERROR", "output-length-capped", "infra-rejected");
    }
    if (manifestText.trim().length === 0) return score("ERROR", "provider-failure", "infra-rejected");
    return null;
}

function invalidOutput(manifestText: string, evidence?: ManifestInfraEvidence): ManifestScore {
    if (
        evidence !== undefined &&
        providerOutputFailureFromInvalidManifest(evidence.messages, manifestText) !== null
    ) {
        return score("ERROR", "provider-failure", "infra-rejected");
    }
    return score("FAIL", "invalid-output", "validation-rejected");
}

/**
 * Collapses `.` and `..` in a path the provider emitted, the way production's
 * `path.resolve` does before `normalizeVerificationFiles` matches it against a
 * tracked path. Gold is already canonical — the scenario contract admits only
 * declared fixture paths — so without this a manifest naming a tracked file
 * through an alias such as `src/./file.ts` scores `wrong-mapping` even though
 * production canonicalizes it and applies exactly the gold path.
 *
 * Separator handling follows the running platform, because production's does: on
 * Windows `path.resolve` treats a backslash as a separator, so `src\file.ts`
 * resolves to the tracked file and is applied, while on a POSIX host the
 * backslash is an ordinary filename character and the path is untracked and
 * dropped. Mirroring that keeps the score equal to what the host would do rather
 * than to what one platform would do.
 *
 * An escaping prefix and a leading separator survive on purpose: production drops
 * a path that leaves the project rather than resolving it inward, so neither may
 * quietly turn into a tracked path here.
 */
function canonicalObservedPath(value: string): string {
    const separators = sep === "\\" ? /[\\/]/ : "/";
    const resolved: string[] = [];
    for (const segment of value.split(separators)) {
        if (segment === "" || segment === ".") continue;
        if (segment === ".." && resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    const joined = resolved.join("/");
    return /^[\\/]/.test(value) ? `/${joined}` : joined;
}

function canonicalObservedPaths(values: readonly string[]): string[] {
    return values.map(canonicalObservedPath);
}

/**
 * Canonicalize an observed path, then resolve its casing against the paths the
 * fixture actually tracks.
 *
 * The casing step mirrors `gitTrackedPath`, which looks for an exact `git
 * ls-files` match, falls back to a case-insensitive one, and applies the tracked
 * spelling it finds. `normalizeVerificationFiles` then stores that spelling, so a
 * manifest naming `SRC/CACHE.ts` applies `src/cache.ts` — even on a
 * case-sensitive filesystem, where the variant does not exist and therefore skips
 * the `existsSync` branch entirely and reaches the git lookup with
 * `safeRealpath` null.
 *
 * Ambiguity is resolved the way production resolves it: only a unique
 * case-insensitive match is adopted. Anything else keeps the observed spelling,
 * which then compares unequal — the same outcome production reaches by dropping a
 * path it cannot bind to one tracked file.
 */
export function canonicalTrackedPaths(values: readonly string[], tracked: readonly string[]): string[] {
    const trackedSet = new Set(tracked.map(canonicalObservedPath));
    return canonicalObservedPaths(values).map((value) => {
        if (trackedSet.has(value)) return value;
        const folded = value.toLowerCase();
        const matches = [...trackedSet].filter((candidate) => candidate.toLowerCase() === folded);
        return matches.length === 1 ? matches[0]! : value;
    });
}

/** Every path the scenario's fixture tracks, which is the universe production's
 *  `git ls-files` lookup resolves an observed path against. */
function trackedPoolPaths(pool: PoolDescriptor): string[] {
    return [...new Set(pool.claims.flatMap((claim) => claim.files))];
}

export function scoreVerifyManifest(
    manifestText: string,
    pool: PoolDescriptor,
    gold: VerifyGold,
    evidence?: ManifestInfraEvidence,
): ManifestScore {
    const rejected = precheck(manifestText, evidence);
    if (rejected !== null) return rejected;
    const context = scoringContext(pool, gold.claims);
    if (isScore(context)) return context;

    const tracked = trackedPoolPaths(pool);

    let parsed: ReturnType<typeof validateVerifyManifest>;
    try {
        parsed = validateVerifyManifest(manifestText, context.expectedIds, new Set());
    } catch {
        return invalidOutput(manifestText, evidence);
    }

    const actual = new Map<
        string,
        { verdict: "verified" | "update" | "archive"; files: string[]; content: string | null }
    >();
    for (const entry of parsed.verified) {
        actual.set(entry.publicClaimId, { verdict: "verified", files: entry.files, content: null });
    }
    for (const entry of parsed.updated) {
        actual.set(entry.publicClaimId, { verdict: "update", files: entry.files, content: entry.content });
    }
    for (const entry of parsed.archived) {
        actual.set(entry.publicClaimId, { verdict: "archive", files: [], content: null });
    }
    const observedFor = (claimId: string) => {
        const publicClaimId = context.byClaimId.get(claimId)?.publicClaimId;
        return publicClaimId === undefined ? undefined : actual.get(publicClaimId);
    };

    // Each archival class gets its own full pass so the reported reason does not
    // depend on the order of gold.claims: an irreversible wrong archival
    // outranks a retained false memory, which outranks any other verdict error.
    for (const expected of gold.claims) {
        const observed = observedFor(expected.claimId);
        if (observed?.verdict === "archive" && expected.verdict !== "archive") {
            return score("FAIL", "wrong-archival", "scored", parsed);
        }
    }
    for (const expected of gold.claims) {
        const observed = observedFor(expected.claimId);
        if (expected.verdict === "archive" && observed?.verdict !== "archive") {
            return score("FAIL", "missed-archival", "scored", parsed);
        }
    }
    for (const expected of gold.claims) {
        const observed = observedFor(expected.claimId);
        if (observed?.verdict !== expected.verdict) {
            return score("FAIL", "wrong-verdict", "scored", parsed);
        }
        // Verification applies this attribute as the claim's new exact mapping,
        // so a narrowed set silently shrinks future incremental verify scope.
        if (
            expected.verdict !== "archive" &&
            !sameSet(canonicalTrackedPaths(observed.files, tracked), expected.expectedFiles)
        ) {
            return score("FAIL", "wrong-mapping", "scored", parsed);
        }
        if (expected.verdict === "update") {
            // Production refuses to apply an empty or over-long replacement
            // body, so a manifest carrying one is not a passing run whatever its
            // anchors say: the experiment would report success for output the
            // host would have rejected.
            const trimmed = observed.content?.trim() ?? "";
            if (trimmed.length === 0 || trimmed.length > VERIFY_UPDATE_CONTENT_MAX_LENGTH) {
                return score("FAIL", "wrong-update-content", "scored", parsed);
            }
            const content = trimmed.toLowerCase();
            const missingRequired = expected.requiredUpdateAnchors.some(
                (anchor) => !content.includes(anchor.toLowerCase()),
            );
            const containsForbidden = expected.forbiddenUpdateAnchors.some((anchor) =>
                content.includes(anchor.toLowerCase()),
            );
            if (missingRequired || containsForbidden) {
                return score("FAIL", "wrong-update-content", "scored", parsed);
            }
        }
    }
    // Appliability is a property of the batch, not of one entry, so it runs once
    // over the parsed updates in the order production stages them.
    if (firstUnappliableUpdate(pool, parsed.updated)) {
        return score("FAIL", "wrong-update-content", "scored", parsed);
    }
    return score("PASS", null, "scored", parsed);
}

/** A claim's dedup identity: its category plus its normalized content. */
export function claimIdentity(category: string, content: string): string {
    return `${category}\u0000${normalizeMemoryContent(content)}`;
}

/**
 * Identities the active pool already owns, keyed to their holder. Shared with the
 * mutation battery so the rule for "this content is already taken" has one
 * definition: the battery plans a manifest against it while the scorer judges
 * one.
 */
export function liveIdentities(pool: PoolDescriptor): Map<string, string> {
    const owner = new Map<string, string>();
    for (const claim of pool.claims) {
        if (claim.lifecycleState === "active") {
            owner.set(claimIdentity(claim.category, claim.content), claim.publicClaimId);
        }
    }
    return owner;
}

/**
 * Whether any update in the batch is one the host could not apply, judged in the
 * order production stages them.
 *
 * `applyVerifyManifest` stages verified entries, then updates, then archives, and
 * each revision asserts its `(category, normalized content)` identity is free
 * among active claims, exempting only the claim being revised. Two consequences
 * a snapshot-only comparison gets wrong in both directions: an update takes its
 * new identity for the rest of the batch, so two updates converging on one
 * identity fail on the second; and an update may legitimately take an identity an
 * earlier update in the same batch vacated. Archives are staged last, so one
 * cannot free an identity for an update.
 */
function firstUnappliableUpdate(
    pool: PoolDescriptor,
    updates: readonly { publicClaimId: string; content: string | null }[],
): boolean {
    const byPublicId = new Map(pool.claims.map((claim) => [claim.publicClaimId, claim]));
    const owner = liveIdentities(pool);
    for (const entry of updates) {
        const claim = byPublicId.get(entry.publicClaimId);
        if (claim === undefined) continue;
        // The revision vacates whatever the claim held before taking its new
        // identity, which is what exempting the claim from its own assertion
        // amounts to across a batch.
        owner.delete(claimIdentity(claim.category, claim.content));
        const next = claimIdentity(claim.category, (entry.content ?? "").trim());
        const held = owner.get(next);
        if (held !== undefined && held !== entry.publicClaimId) return true;
        owner.set(next, entry.publicClaimId);
    }
    return false;
}

export function scoreMapManifest(
    manifestText: string,
    pool: PoolDescriptor,
    gold: MapGold,
    evidence?: ManifestInfraEvidence,
): ManifestScore {
    const rejected = precheck(manifestText, evidence);
    if (rejected !== null) return rejected;
    const context = scoringContext(pool, gold.claims);
    if (isScore(context)) return context;

    const tracked = trackedPoolPaths(pool);

    let parsed: ReturnType<typeof validateMapMemoriesManifest>;
    try {
        parsed = validateMapMemoriesManifest(manifestText, context.expectedIds);
    } catch {
        return invalidOutput(manifestText, evidence);
    }
    const actual = new Map(parsed.map((entry) => [entry.publicClaimId, entry]));
    for (const expected of gold.claims) {
        const publicClaimId = context.byClaimId.get(expected.claimId)?.publicClaimId;
        if (publicClaimId === undefined || actual.get(publicClaimId)?.independent !== expected.independent) {
            return score("FAIL", "wrong-independence", "scored", parsed);
        }
    }
    for (const expected of gold.claims) {
        const publicClaimId = context.byClaimId.get(expected.claimId)?.publicClaimId;
        const observed = publicClaimId === undefined ? undefined : actual.get(publicClaimId);
        if (observed === undefined || !sameSet(canonicalTrackedPaths(observed.files, tracked), expected.files)) {
            return score("FAIL", "wrong-mapping", "scored", parsed);
        }
    }
    return score("PASS", null, "scored", parsed);
}

export function scoreClassifyManifest(
    manifestText: string,
    pool: PoolDescriptor,
    gold: ClassifyGold,
    evidence?: ManifestInfraEvidence,
): ManifestScore {
    const rejected = precheck(manifestText, evidence);
    if (rejected !== null) return rejected;
    const context = scoringContext(pool, gold.claims);
    if (isScore(context)) return context;

    let parsed: ReturnType<typeof validateClassifyManifest>;
    try {
        parsed = validateClassifyManifest(manifestText, context.expectedIds);
    } catch {
        return invalidOutput(manifestText, evidence);
    }
    const actual = new Map(parsed.map((entry) => [entry.publicClaimId, entry]));
    const poolByClaimId = new Map(pool.claims.map((claim) => [claim.claimId, claim]));
    for (const expected of gold.claims) {
        const publicClaimId = context.byClaimId.get(expected.claimId)?.publicClaimId;
        const observed = publicClaimId === undefined ? undefined : actual.get(publicClaimId);
        const current = poolByClaimId.get(expected.claimId);
        if (observed === undefined || current === undefined) {
            return score("FAIL", "wrong-classification", "scored", parsed);
        }
        // A manifest entry may report any subset of the three fields — the parser
        // requires at least one and coverage is enforced per claim — and
        // production preserves whatever the entry omits. The applied value is
        // therefore the reported one where present and the claim's current value
        // otherwise, so scoring the reported field alone fails a run whose
        // resulting pool matches gold.
        const importance = observed.importance ?? current.importance;
        const scope = observed.scope ?? current.memoryScope;
        const reportedShareable = observed.shareable;
        const preservedShareable = reportedShareable ?? current.sharing === "shareable";
        // `applyClassifications` forces a reported `true` to false when the claim
        // content trips the same predicate, so that is the value the pool ends up
        // with. Scoring the raw `true` would fail a run whose applied pool
        // matches gold. The override fires only on a reported `true`, so an
        // omitted field still resolves to the preserved value.
        const shareable =
            reportedShareable === true && hasShareabilitySensitiveText(current.content)
                ? false
                : preservedShareable;
        if (
            importance < expected.importance.min ||
            importance > expected.importance.max ||
            scope !== expected.scope ||
            shareable !== expected.shareable
        ) {
            return score("FAIL", "wrong-classification", "scored", parsed);
        }
    }
    return score("PASS", null, "scored", parsed);
}
