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
 * Preserve whether the path has a leading separator and unresolved leading `..` segments.
 *
 *
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
        if (expected.verdict !== "archive" && !sameSet(canonicalObservedPaths(observed.files), expected.expectedFiles)) {
            return score("FAIL", "wrong-mapping", "scored", parsed);
        }
        if (expected.verdict === "update") {
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
    if (firstUnappliableUpdate(pool, parsed.updated)) {
        return score("FAIL", "wrong-update-content", "scored", parsed);
    }
    return score("PASS", null, "scored", parsed);
}

/* */
export function claimIdentity(category: string, content: string): string {
    return `${category}\u0000${normalizeMemoryContent(content)}`;
}

/**
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
 *
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
        const importance = observed.importance ?? current.importance;
        const scope = observed.scope ?? current.memoryScope;
        const reportedShareable = observed.shareable;
        const preservedShareable = reportedShareable ?? current.sharing === "shareable";
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
