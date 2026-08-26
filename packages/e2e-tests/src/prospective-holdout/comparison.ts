import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import type { CohortCloseManifest, ReleaseFreezeManifest } from "./contract";
import { HoldoutContractError } from "./contract";
import type { ProspectiveCellResult } from "./runner";

export type PairStatus = "complete" | "incomplete";
export interface PairedCaseFact {
    caseId: string;
    familyId: string;
    implementationFingerprint: string;
    releaseN: ProspectiveCellResult;
    releaseNMinus1: ProspectiveCellResult;
    status: PairStatus;
}

export interface CellAttempt {
    attempt: number;
    cell: ProspectiveCellResult;
}

function identity(cell: ProspectiveCellResult): string {
    return `${cell.caseId}:${cell.releaseRole}`;
}

export function buildPairedFacts(
    close: CohortCloseManifest,
    attempts: readonly CellAttempt[],
    pairedRetryLimit: number,
    freeze: ReleaseFreezeManifest,
): PairedCaseFact[] {
    if (
        close.body.epochId !== freeze.body.epochId ||
        close.body.freezeManifestFingerprint !== canonicalFingerprint(freeze)
    ) {
        throw new HoldoutContractError(["comparison: close-freeze-binding-mismatch"]);
    }
    if (!Number.isSafeInteger(pairedRetryLimit) || pairedRetryLimit < 0) {
        throw new HoldoutContractError(["comparison: retry-limit-invalid"]);
    }
    const admitted = new Map(close.body.cases.map((entry) => [entry.caseId, entry]));
    const byAttempt = new Map<number, Map<string, ProspectiveCellResult>>();
    for (const item of attempts) {
        if (!Number.isSafeInteger(item.attempt) || item.attempt < 0 || item.attempt > pairedRetryLimit) {
            throw new HoldoutContractError(["comparison: attempt-invalid"]);
        }
        if (!admitted.has(item.cell.caseId)) throw new HoldoutContractError(["comparison: unadmitted-cell"]);
        const frozenRelease = freeze.body.releases.find((release) => release.role === item.cell.releaseRole)!;
        if (
            item.cell.expectedReleaseId !== frozenRelease.releaseId ||
            item.cell.releaseRootManifestFingerprint !== frozenRelease.releaseRootManifestFingerprint ||
            item.cell.releaseIdentityFingerprint !== canonicalFingerprint(frozenRelease)
        ) {
            throw new HoldoutContractError(["comparison: frozen-release-binding-mismatch"]);
        }
        const cells = byAttempt.get(item.attempt) ?? new Map<string, ProspectiveCellResult>();
        const key = identity(item.cell);
        if (cells.has(key)) throw new HoldoutContractError(["comparison: duplicate-cell"]);
        cells.set(key, item.cell);
        byAttempt.set(item.attempt, cells);
    }
    for (const [attempt, cells] of byAttempt) {
        for (const caseId of admitted.keys()) {
            const left = cells.has(`${caseId}:release-n`);
            const right = cells.has(`${caseId}:release-n-minus-1`);
            if (left !== right) {
                throw new HoldoutContractError([`comparison: unpaired-retry-${attempt}`]);
            }
        }
    }
    const facts: PairedCaseFact[] = [];
    for (const [caseId, closed] of admitted) {
        let chosen: Map<string, ProspectiveCellResult> | undefined;
        for (let attempt = 0; attempt <= pairedRetryLimit; attempt += 1) {
            const candidate = byAttempt.get(attempt);
            if (candidate?.has(`${caseId}:release-n`) && candidate.has(`${caseId}:release-n-minus-1`)) {
                chosen = candidate;
                const n = candidate.get(`${caseId}:release-n`)!;
                const previous = candidate.get(`${caseId}:release-n-minus-1`)!;
                if (n.runHealth === "completed" && previous.runHealth === "completed") break;
            }
        }
        if (!chosen) throw new HoldoutContractError(["comparison: missing-pair"]);
        const releaseN = chosen.get(`${caseId}:release-n`)!;
        const releaseNMinus1 = chosen.get(`${caseId}:release-n-minus-1`)!;
        if (
            releaseN.familyId !== closed.familyId ||
            releaseNMinus1.familyId !== closed.familyId ||
            releaseN.implementationFingerprint !== releaseNMinus1.implementationFingerprint
        ) {
            throw new HoldoutContractError(["comparison: pair-binding-mismatch"]);
        }
        facts.push({
            caseId,
            familyId: closed.familyId,
            implementationFingerprint: releaseN.implementationFingerprint,
            releaseN,
            releaseNMinus1,
            status: releaseN.runHealth === "completed" && releaseNMinus1.runHealth === "completed"
                ? "complete"
                : "incomplete",
        });
    }
    return facts.sort((left, right) => left.caseId.localeCompare(right.caseId));
}

export function assertAaSymmetry(left: ProspectiveCellResult, right: ProspectiveCellResult): void {
    const projection = (cell: ProspectiveCellResult) => ({
        caseId: cell.caseId,
        familyId: cell.familyId,
        root: cell.observedRootFingerprint,
        implementation: cell.implementationFingerprint,
        harness: cell.harness,
        health: cell.runHealth,
        outcome: cell.productOutcome,
        checks: cell.failedChecks,
        reason: cell.reasonCode,
    });
    if (JSON.stringify(projection(left)) !== JSON.stringify(projection(right))) {
        throw new HoldoutContractError(["comparison: aa-asymmetry"]);
    }
}
