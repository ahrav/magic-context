import { readFileSync } from "node:fs";

import { hasShareabilitySensitiveText } from "../../../plugin/src/shared/redaction";
import type {
    ClaimSnapshotProjection,
    DreamerEvalRunReport,
    DreamerSystemTuple,
    DreamerTask,
    ErrorReason,
    FailReason,
} from "./contract";
import { parseRunReport } from "./contract";
import { sha256Utf8Hex } from "../../../plugin/src/features/magic-context/memory/storage-claims";
import { canonicalTrackedPaths } from "./scorer";

export interface DreamerClaimVerdictHistogram {
    claimId: string;
    counts: Record<string, number>;
    disagreement: boolean;
}

export interface DreamerVarianceArtifact {
    scenarioId: string;
    task: DreamerTask;
    repeatCount: number;
    system: DreamerSystemTuple;
    runs: Array<{
        runId: string;
        status: DreamerEvalRunReport["status"];
        reason: ErrorReason | FailReason | null;
        runFatal: boolean;
    }>;
    claimHistograms: DreamerClaimVerdictHistogram[];
    red: boolean;
    runFatal: boolean;
}

/**
 * Bucket for a run that produced no verdict for a claim — a lost or unparseable
 * manifest, or a capture that never observed the claim at all. Without it a
 * claim verified in two of three runs and missing from the third reads as
 * unanimous, and a claim missing from every run vanishes from the artifact, so
 * run-to-run output loss would be invisible in the one file that exists to
 * expose run-to-run difference.
 */
const MISSING_VERDICT = "missing";

function object(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function publicClaimId(value: unknown): string | null {
    const entry = object(value);
    return typeof entry?.publicClaimId === "string" ? entry.publicClaimId : null;
}

/**
 * Encode a mapping entry the way `scoreMapManifest` compares one: it canonicalizes
 * the observed paths, then tests them against gold with set equality, so
 * duplicate entries and equivalent spellings such as `src/./cache.ts` are already
 * immaterial to PASS/FAIL and must not read as a different verdict.
 *
 * Independence and the path set are encoded together because the scorer checks
 * both — independence first, then files — so a claim's bucket has to carry
 * whatever could have made those two checks disagree between repeats.
 */
function mapVerdict(entry: Record<string, unknown>, tracked: readonly string[]): string {
    const observed = Array.isArray(entry.files)
        ? entry.files.filter((file): file is string => typeof file === "string")
        : [];
    const files = [...new Set(canonicalTrackedPaths(observed, tracked))].sort();
    return `independent:${String(entry.independent === true)};files:${files.join(",")}`;
}

/**
 * Encode a classification the way `scoreClassifyManifest` scores one: an omitted
 * attribute resolves to the claim's stored value, and a reported `shareable`
 * of true is forced false when the content trips the shareability predicate.
 * Both are production-valid partial manifests, so encoding the raw entry would
 * report `scope:undefined` against `scope:project` — syntactic omission — as
 * model variance even though the two runs reach the same applied state.
 */
function classifyVerdict(entry: Record<string, unknown>, current: ClaimSnapshotProjection | undefined): string {
    const importance = entry.importance ?? current?.importance;
    const scope = entry.scope ?? current?.memoryScope;
    const reported = entry.shareable;
    const preserved = reported ?? (current?.sharing === "shareable");
    const shareable =
        reported === true && current !== undefined && hasShareabilitySensitiveText(current.content)
            ? false
            : preserved;
    return `importance:${String(importance)};scope:${String(scope)};shareable:${String(shareable)}`;
}

/**
 * Encode a verify entry the way `scoreVerifyManifest` judges one. The verdict
 * alone is not the scored unit: a retained claim's canonical file set decides
 * `wrong-mapping`, and an update's replacement body decides
 * `wrong-update-content`, so two repeats can share a verdict while one passes and
 * the other fails.
 *
 * The body is recorded as a digest of its trimmed, lowercased form — the shape
 * the scorer's anchor matching sees — so whitespace and case differences do not
 * register, while a genuinely different replacement body does. That is real
 * variance: the body becomes the claim's stored content, so two repeats writing
 * different text left the pool in different states.
 *
 * Archived entries carry neither: the parser forces their file set empty and the
 * scorer skips both checks for them.
 */
function verifyVerdict(
    verdict: "verified" | "update" | "archive",
    entry: Record<string, unknown>,
    tracked: readonly string[],
): string {
    if (verdict === "archive") return "archive";
    const observed = Array.isArray(entry.files)
        ? entry.files.filter((file): file is string => typeof file === "string")
        : [];
    const files = [...new Set(canonicalTrackedPaths(observed, tracked))].sort().join(",");
    if (verdict === "verified") return `verified;files:${files}`;
    const content = typeof entry.content === "string" ? entry.content.trim().toLowerCase() : "";
    return `update;files:${files};content:${sha256Utf8Hex(content).slice(0, 12)}`;
}

function observedVerdicts(report: DreamerEvalRunReport): Map<string, string> {
    const observed = new Map<string, string>();
    if (report.parsedManifest === null) return observed;
    const tracked = [...new Set(report.poolBefore.flatMap((claim) => claim.files))];
    if (report.task === "verify" || report.task === "verify-broad") {
        const manifest = object(report.parsedManifest);
        for (const [field, verdict] of [
            ["verified", "verified"],
            ["updated", "update"],
            ["archived", "archive"],
        ] as const) {
            const entries = manifest?.[field];
            if (!Array.isArray(entries)) continue;
            for (const value of entries) {
                const entry = object(value);
                const id = publicClaimId(entry);
                if (entry === null || id === null) continue;
                observed.set(id, verifyVerdict(verdict, entry, tracked));
            }
        }
        return observed;
    }
    if (!Array.isArray(report.parsedManifest)) return observed;
    const currentByPublicId = new Map(report.poolBefore.map((claim) => [claim.publicClaimId, claim]));
    for (const value of report.parsedManifest) {
        const entry = object(value);
        const id = publicClaimId(entry);
        if (entry === null || id === null) continue;
        observed.set(
            id,
            report.task === "map-memories"
                ? mapVerdict(entry, tracked)
                : classifyVerdict(entry, currentByPublicId.get(id)),
        );
    }
    return observed;
}

/**
 * Compare system tuples by field rather than by `JSON.stringify`, whose output
 * depends on key insertion order: a report rebuilt or deserialized with a
 * different order carries the same system and must not be rejected as a
 * different one.
 */
function systemIdentity(system: DreamerSystemTuple): string {
    return [
        system.repoCommitSha,
        system.bunVersion,
        system.opencodeVersion,
        system.modelId,
        system.parserImpl,
    ].join("\u0000");
}

export function aggregateDreamerEvalVariance(reports: readonly DreamerEvalRunReport[]): DreamerVarianceArtifact {
    const first = reports[0];
    if (first === undefined) throw new Error("variance requires at least one report");
    const identity = systemIdentity(first.system);
    if (reports.some((report) => systemIdentity(report.system) !== identity)) {
        throw new Error("variance reports must share one system tuple");
    }
    if (reports.some((report) => report.scenarioId !== first.scenarioId || report.task !== first.task)) {
        throw new Error("variance reports must share one scenario and task");
    }

    const counts = new Map<string, Map<string, number>>();
    // Public claim ids are minted per run, so the population is keyed by logical
    // claim id and each run resolves its own public ids through its own capture.
    const population = [...new Set(reports.flatMap((report) => report.poolBefore.map((claim) => claim.claimId)))];
    for (const report of reports) {
        const observed = observedVerdicts(report);
        const publicByClaimId = new Map(report.poolBefore.map((claim) => [claim.claimId, claim.publicClaimId]));
        for (const claimId of population) {
            const publicId = publicByClaimId.get(claimId);
            const verdict = (publicId === undefined ? undefined : observed.get(publicId)) ?? MISSING_VERDICT;
            const histogram = counts.get(claimId) ?? new Map<string, number>();
            histogram.set(verdict, (histogram.get(verdict) ?? 0) + 1);
            counts.set(claimId, histogram);
        }
    }

    const claimHistograms = [...counts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([claimId, histogram]) => {
            const entries = [...histogram].sort(([left], [right]) => left.localeCompare(right));
            return {
                claimId,
                counts: Object.fromEntries(entries),
                disagreement: entries.length > 1,
            };
        });
    return {
        scenarioId: first.scenarioId,
        task: first.task,
        repeatCount: reports.length,
        system: first.system,
        runs: reports.map((report) => ({
            runId: report.runId,
            status: report.status,
            reason: report.reason,
            runFatal: report.runFatal,
        })),
        claimHistograms,
        red: reports.some((report) => report.status !== "PASS"),
        runFatal: reports.some((report) => report.runFatal),
    };
}

export function aggregateDreamerEvalVarianceFiles(paths: readonly string[]): DreamerVarianceArtifact {
    return aggregateDreamerEvalVariance(
        paths.map((path) => parseRunReport(JSON.parse(readFileSync(path, "utf8")), path)),
    );
}
