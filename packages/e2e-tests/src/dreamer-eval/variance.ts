import type { DreamerEvalRunReport, DreamerSystemTuple, DreamerTask, ErrorReason, FailReason } from "./contract";

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

function object(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function publicClaimId(value: unknown): string | null {
    const entry = object(value);
    return typeof entry?.publicClaimId === "string" ? entry.publicClaimId : null;
}

function observedVerdicts(report: DreamerEvalRunReport): Map<string, string> {
    const observed = new Map<string, string>();
    if (report.parsedManifest === null) return observed;
    if (report.task === "verify" || report.task === "verify-broad") {
        const manifest = object(report.parsedManifest);
        for (const [field, verdict] of [
            ["verified", "verified"],
            ["updated", "update"],
            ["archived", "archive"],
        ] as const) {
            const entries = manifest?.[field];
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
                const id = publicClaimId(entry);
                if (id !== null) observed.set(id, verdict);
            }
        }
        return observed;
    }
    if (!Array.isArray(report.parsedManifest)) return observed;
    for (const value of report.parsedManifest) {
        const entry = object(value);
        const id = publicClaimId(entry);
        if (entry === null || id === null) continue;
        if (report.task === "map-memories") {
            const files = Array.isArray(entry.files)
                ? entry.files.filter((file): file is string => typeof file === "string").sort()
                : [];
            observed.set(id, entry.independent === true ? "independent" : `files:${files.join(",")}`);
        } else {
            observed.set(
                id,
                `importance:${String(entry.importance)};scope:${String(entry.scope)};shareable:${String(entry.shareable)}`,
            );
        }
    }
    return observed;
}

export function aggregateDreamerEvalVariance(reports: readonly DreamerEvalRunReport[]): DreamerVarianceArtifact {
    const first = reports[0];
    if (first === undefined) throw new Error("variance requires at least one report");
    const systemIdentity = JSON.stringify(first.system);
    if (reports.some((report) => JSON.stringify(report.system) !== systemIdentity)) {
        throw new Error("variance reports must share one system tuple");
    }
    if (reports.some((report) => report.scenarioId !== first.scenarioId || report.task !== first.task)) {
        throw new Error("variance reports must share one scenario and task");
    }

    const counts = new Map<string, Map<string, number>>();
    for (const report of reports) {
        const logicalByPublic = new Map(report.poolBefore.map((claim) => [claim.publicClaimId, claim.claimId]));
        for (const [publicId, verdict] of observedVerdicts(report)) {
            const claimId = logicalByPublic.get(publicId);
            if (claimId === undefined) continue;
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
