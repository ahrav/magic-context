import { type Database, isInTransaction } from "../../../shared/sqlite";
import type {
    CanonicalJsonValue,
    ClaimOperationResultEffect,
} from "../memory/claim-operation-contract";
import {
    type AntiMemoryPayload,
    renderAntiMemoryContent,
    stageCreateAntiMemoryInCurrentTransaction,
} from "../memory/storage-anti-memory";
import {
    type AutonomousManifestIdentity,
    runAutonomousCreationManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import { stageCreateProjectMemoryClaimInCurrentTransaction } from "../memory/storage-claim-operations";
import { ensureProject, sha256Utf8Hex } from "../memory/storage-claims";
import type { MemoryCategory } from "../memory/types";
import { insertUserMemoryCandidates } from "../user-memory/storage-user-memory";

/**
 * A durable learning must not preserve session-local anger/friction language
 * verbatim ("distill, don't transcribe"). This catches the strongest correction
 * phrases + repeated no/wrong/again/stop runs + punctuation bursts.
 */
const FRUSTRATION_MARKER_REGEX =
    /\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using)|(?:no|wrong|again|stop)(?:\W+\b(?:no|wrong|again|stop)\b)+)\b|[!?]{3,}/i;

export type RetrospectiveLearningRoute = "memory" | "observation" | "anti_memory";

export type ParsedRetrospectiveLearning =
    | { route: "memory"; content: string; category: MemoryCategory }
    | { route: "observation"; content: string }
    | { route: "anti_memory"; payload: AntiMemoryPayload };

export interface RetrospectiveApplyResult {
    memoryWritten: number;
    observationsInserted: number;
    observationsDropped: number;
    rejected: Array<{ content: string; reason: string }>;
    /**
     * Effects of the claim-native creation manifest. Route-`memory` learnings
     * write only the claim tables, so a caller diffing the legacy `memories`
     * table sees no change; run telemetry has to come from these instead.
     */
    effects: readonly ClaimOperationResultEffect[];
}

const LEARNINGS_BLOCK_REGEX = /<learnings\b[^>]*>(.*?)<\/learnings>/is;
const LEARNING_REGEX = /<learning\b([^>]*)>(.*?)<\/learning>/gis;
const ATTR_REGEX = /([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g;
const VALID_MEMORY_CATEGORIES = new Set<MemoryCategory>([
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
]);
const RAW_QUOTE_REGEX = /["“”][^"“”]{4,}["“”]|'[^']{4,}'/;
const DATE_REGEX =
    /\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/20\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i;

export function parseRetrospectiveLearnings(text: string): ParsedRetrospectiveLearning[] {
    const block = text.match(LEARNINGS_BLOCK_REGEX)?.[1];
    if (!block) return [];

    const learnings: ParsedRetrospectiveLearning[] = [];
    for (const match of block.matchAll(LEARNING_REGEX)) {
        const attrs = parseAttributes(match[1] ?? "");
        const route = attrs.route;
        if (route === "anti_memory") {
            const inner = match[2] ?? "";
            const trigger = childText(inner, "trigger");
            const rejectedStrategy = childText(inner, "rejected_strategy");
            const rejectionReason = childText(inner, "rejection_reason");
            if (!trigger || !rejectedStrategy || !rejectionReason) continue;
            learnings.push({
                route,
                payload: {
                    trigger,
                    rejectedStrategy,
                    rejectionReason,
                    saferAlternative: childText(inner, "safer_alternative"),
                    preconditions: childText(inner, "preconditions"),
                    attemptedApproach: childText(inner, "attempted_approach"),
                    observedFailure: childText(inner, "observed_failure"),
                    rootCause: childText(inner, "root_cause"),
                    recovery: childText(inner, "recovery"),
                    nonApplicableWhen: childText(inner, "non_applicable_when"),
                },
            });
            continue;
        }
        if (route !== "memory" && route !== "observation") continue;
        const content = unescapeXml((match[2] ?? "").trim())
            .replace(/\s+/g, " ")
            .trim();
        if (!content) continue;

        if (route === "memory") {
            const category = attrs.category;
            if (!VALID_MEMORY_CATEGORIES.has(category as MemoryCategory)) continue;
            learnings.push({ route, category: category as MemoryCategory, content });
        } else {
            learnings.push({ route, content });
        }
    }
    return learnings;
}

function childText(inner: string, tag: string): string | null {
    const match = inner.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (!match) return null;
    const value = unescapeXml(match[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();
    return value || null;
}

// A learning that shares a long verbatim run of words with a source user message
// is a transcription, not a distillation — reject it. (Privacy: the durable
// memory must be the third-person LESSON, never the user's own words.)
export const MAX_SOURCE_WORD_RUN = 7;
export const MAX_SOURCE_WORD_RUN_RATIO = 0.5;
// The LEARNING is short by nature (a one-line lesson); cap it as defense. The
// SOURCE is NOT capped — see hasHighSourceOverlap: the n-gram membership check is
// O(source) time / O(learning) memory, so the whole source is scanned and a
// verbatim run anywhere in it is caught (no leading-window truncation gap).
export const MAX_OVERLAP_LEARNING_WORDS = 200;

function toWords(text: string, cap?: number): string[] {
    const words = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length > 0);
    return cap !== undefined && words.length > cap ? words.slice(0, cap) : words;
}

/**
 * True when `content` reads as a near-transcription of any source user line:
 * it shares a contiguous run of ≥ runCap words (an absolute cap of
 * MAX_SOURCE_WORD_RUN, or half the learning's own length for very short
 * learnings). This is the structural enforcement of "distill, don't transcribe"
 * — the regexes catch quotes/dates/anger; this catches a lightly-reworded user
 * sentence that would otherwise pass.
 *
 * Implementation: since runCap ≤ MAX_SOURCE_WORD_RUN (small), "a shared run ≥
 * runCap exists" is equivalent to "some runCap-gram of the learning occurs in the
 * source". We build the learning's runCap-grams once (≤ learning length) and
 * stream each FULL source past them — O(Σ source words) time, O(learning) memory,
 * with NO source truncation (a verbatim run at any offset is caught).
 */
export function hasHighSourceOverlap(content: string, sourceUserTexts: string[]): boolean {
    const learningWords = toWords(content, MAX_OVERLAP_LEARNING_WORDS);
    if (learningWords.length === 0) return false;
    const runCap = Math.min(
        MAX_SOURCE_WORD_RUN,
        Math.max(3, Math.ceil(learningWords.length * MAX_SOURCE_WORD_RUN_RATIO)),
    );
    if (learningWords.length < runCap) return false;

    // All runCap-length contiguous grams of the learning (joined on \u0000 so
    // word boundaries are unambiguous).
    const learningGrams = new Set<string>();
    for (let i = 0; i + runCap <= learningWords.length; i++) {
        learningGrams.add(learningWords.slice(i, i + runCap).join("\u0000"));
    }
    if (learningGrams.size === 0) return false;

    for (const source of sourceUserTexts) {
        const words = toWords(source);
        for (let i = 0; i + runCap <= words.length; i++) {
            if (learningGrams.has(words.slice(i, i + runCap).join("\u0000"))) return true;
        }
    }
    return false;
}

export function validateRetrospectiveLearningText(
    content: string,
    sourceUserTexts: readonly string[] = [],
): string | null {
    if (RAW_QUOTE_REGEX.test(content)) return "raw_quote";
    if (DATE_REGEX.test(content)) return "date";
    if (FRUSTRATION_MARKER_REGEX.test(content)) return "frustration_marker";
    if (hasHighSourceOverlap(content, [...sourceUserTexts])) return "source_overlap";
    return null;
}

export function applyRetrospectiveLearnings(args: {
    db: Database;
    projectIdentity: string;
    sourceSessionId: string;
    learnings: ParsedRetrospectiveLearning[];
    identity: AutonomousManifestIdentity;
    userMemoryCollectionEnabled: boolean;
    /** The raw source user lines, for the near-transcription reject check. */
    sourceUserTexts?: readonly string[];
}): RetrospectiveApplyResult {
    if (!isInTransaction(args.db)) {
        throw new Error("applyRetrospectiveLearnings requires an active transaction");
    }
    const rejected: Array<{ content: string; reason: string }> = [];
    const claims: Array<
        | { route: "memory"; content: string; category: MemoryCategory; index: number }
        | { route: "anti_memory"; payload: AntiMemoryPayload; content: string; index: number }
    > = [];
    const observations: Array<{ content: string; sessionId: string }> = [];
    const sourceUserTexts = args.sourceUserTexts ?? [];
    const seenContent = new Set<string>();

    for (const [index, learning] of args.learnings.entries()) {
        const content =
            learning.route === "anti_memory"
                ? renderAntiMemoryContent(learning.payload)
                : learning.content;
        const category = learning.route === "memory" ? learning.category : "";
        const dedupeKey = `${learning.route}:${category}:${content}`;
        if (seenContent.has(dedupeKey)) continue;
        seenContent.add(dedupeKey);
        const fields =
            learning.route === "anti_memory"
                ? [
                      learning.payload.trigger,
                      learning.payload.rejectedStrategy,
                      learning.payload.rejectionReason,
                      learning.payload.saferAlternative,
                      learning.payload.preconditions,
                      learning.payload.attemptedApproach,
                      learning.payload.observedFailure,
                      learning.payload.rootCause,
                      learning.payload.recovery,
                      learning.payload.nonApplicableWhen,
                  ].filter((value): value is string => typeof value === "string")
                : [content];
        const rejectReason = fields
            .map((field) => validateRetrospectiveLearningText(field, sourceUserTexts))
            .find((reason) => reason !== null);
        if (rejectReason) {
            rejected.push({ content, reason: rejectReason });
            continue;
        }
        if (learning.route === "memory") {
            claims.push({ ...learning, index });
        } else if (learning.route === "anti_memory") {
            claims.push({ ...learning, content, index });
        } else if (learning.route === "observation" && args.userMemoryCollectionEnabled) {
            observations.push({ content, sessionId: args.sourceSessionId });
        }
    }

    const observationsDropped = args.userMemoryCollectionEnabled
        ? 0
        : args.learnings.filter(
              (learning) =>
                  learning.route === "observation" &&
                  !rejected.some((item) => item.content === learning.content),
          ).length;
    const manifest: CanonicalJsonValue[] = [];
    for (const learning of args.learnings) {
        if (learning.route === "anti_memory") {
            manifest.push({
                payload: {
                    attemptedApproach: learning.payload.attemptedApproach ?? null,
                    nonApplicableWhen: learning.payload.nonApplicableWhen ?? null,
                    observedFailure: learning.payload.observedFailure ?? null,
                    preconditions: learning.payload.preconditions ?? null,
                    recovery: learning.payload.recovery ?? null,
                    rejectedStrategy: learning.payload.rejectedStrategy,
                    rejectionReason: learning.payload.rejectionReason,
                    rootCause: learning.payload.rootCause ?? null,
                    saferAlternative: learning.payload.saferAlternative ?? null,
                    trigger: learning.payload.trigger,
                },
                route: learning.route,
            });
        } else {
            manifest.push({
                category: learning.route === "memory" ? learning.category : null,
                content: learning.content,
                route: learning.route,
            });
        }
    }
    const projectId = ensureProject(args.db, args.projectIdentity);
    const operation = runAutonomousCreationManifestInCurrentTransaction({
        db: args.db,
        identity: args.identity,
        items: claims.map((learning) => ({
            key: {
                category: learning.route === "memory" ? learning.category : "REJECTED_APPROACH",
                contentDigest: sha256Utf8Hex(learning.content),
                index: learning.index,
            },
            value: learning,
        })),
        manifest,
        resultSummary: {
            observationsDropped,
            observationsInserted: observations.length,
            rejected: rejected.length,
        },
        stageItem: (db, item, nowMs) => {
            const provenance = {
                sourceLocator: `retrospective://${args.identity.runId}/${args.identity.batchId}/${item.value.index}`,
                sourceContent: item.value.content,
                sourceSessionId: args.sourceSessionId,
                extractor: "dreamer-retrospective",
                extractorVersion: "direct-claims-v1",
                extractorRunId: args.identity.runId,
                independenceKey: `retrospective:${args.identity.runId}:${item.value.index}`,
                sourceTrustClass: "model_inference" as const,
            };
            return item.value.route === "anti_memory"
                ? stageCreateAntiMemoryInCurrentTransaction(
                      db,
                      {
                          projectId,
                          payload: item.value.payload,
                          provenance,
                          actor: args.identity.producer,
                          nowMs,
                      },
                      nowMs,
                  )
                : stageCreateProjectMemoryClaimInCurrentTransaction(
                      db,
                      {
                          projectId,
                          content: item.value.content,
                          category: item.value.category,
                          provenance,
                          actor: args.identity.producer,
                          nowMs,
                      },
                      nowMs,
                  );
        },
    });
    if (!operation.operation.replayed && observations.length > 0) {
        insertUserMemoryCandidates(args.db, observations);
    }
    const payload = operation.operation.result.payload as { items?: unknown } | null;
    const memoryWritten = Array.isArray(payload?.items)
        ? payload.items.filter(
              (item) =>
                  item !== null &&
                  typeof item === "object" &&
                  !Array.isArray(item) &&
                  (item as { kind?: unknown }).kind === "created",
          ).length
        : 0;
    return {
        memoryWritten,
        observationsInserted: observations.length,
        observationsDropped,
        rejected,
        effects: operation.operation.result.effects,
    };
}

function parseAttributes(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of raw.matchAll(ATTR_REGEX)) {
        attrs[match[1]] = unescapeXml(match[2] ?? "");
    }
    return attrs;
}

function unescapeXml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
