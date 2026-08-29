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
        if (expected.verdict !== "archive" && !sameSet(canonicalObservedPaths(observed.files), expected.expectedFiles)) {
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
            // Revision refuses content whose normalized hash is already owned by
            // another live claim in the same category
            // (`assertNoLiveDuplicate`, exempting only the claim being revised),
            // so a body colliding with a sibling's content throws instead of
            // applying. Scoring it green would credit output the host cannot
            // write.
            if (collidesWithLiveClaim(pool, expected.claimId, trimmed)) {
                return score("FAIL", "wrong-update-content", "scored", parsed);
            }
        }
    }
    return score("PASS", null, "scored", parsed);
}

/**
 * Whether replacement content would land on another live claim's
 * `(category, normalized content)` identity. Production's revision path asserts
 * that identity is free, exempting only the claim being revised, and throws
 * otherwise — so such a manifest is unappliable however well its anchors read.
 * Archived and retired rows are excluded, matching the `lifecycle_state =
 * 'active'` the assertion queries.
 */
function collidesWithLiveClaim(pool: PoolDescriptor, claimId: string, content: string): boolean {
    const revised = pool.claims.find((claim) => claim.claimId === claimId);
    if (revised === undefined) return false;
    const normalized = normalizeMemoryContent(content);
    return pool.claims.some(
        (claim) =>
            claim.claimId !== claimId &&
            claim.lifecycleState === "active" &&
            claim.category === revised.category &&
            normalizeMemoryContent(claim.content) === normalized,
    );
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
        if (observed === undefined || !sameSet(canonicalObservedPaths(observed.files), expected.files)) {
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
