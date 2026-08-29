import { hasLengthCappedOutput } from "../../../plugin/src/shared/assistant-message-extractor";
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
        if (expected.verdict !== "archive" && !sameSet(observed.files, expected.expectedFiles)) {
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
    return score("PASS", null, "scored", parsed);
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
        if (observed === undefined || !sameSet(observed.files, expected.files)) {
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
    for (const expected of gold.claims) {
        const publicClaimId = context.byClaimId.get(expected.claimId)?.publicClaimId;
        const observed = publicClaimId === undefined ? undefined : actual.get(publicClaimId);
        if (
            observed?.importance === undefined ||
            observed.importance < expected.importance.min ||
            observed.importance > expected.importance.max ||
            observed.scope !== expected.scope ||
            observed.shareable !== expected.shareable
        ) {
            return score("FAIL", "wrong-classification", "scored", parsed);
        }
    }
    return score("PASS", null, "scored", parsed);
}
