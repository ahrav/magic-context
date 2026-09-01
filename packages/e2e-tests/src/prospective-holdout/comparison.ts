import { canonicalFingerprint } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { compareCodeUnits } from "../code-unit-order";
import type { CohortCloseManifest, ReleaseFreezeManifest } from "./contract";
import { HoldoutContractError } from "./contract";
import type { ProspectiveCellResult } from "./runner";

export type PairStatus = "complete" | "incomplete";
export interface PairedCaseFact {
    caseId: string;
    familyId: string;
    implementationFingerprint: string;
    model: string;
    seed: number;
    platform: string;
    releaseN: ProspectiveCellResult;
    releaseNMinus1: ProspectiveCellResult;
    status: PairStatus;
}

export interface CellAttempt {
    attempt: number;
    cell: ProspectiveCellResult;
}

export interface AaPair {
    left: ProspectiveCellResult;
    right: ProspectiveCellResult;
}

function coordinate(cell: ProspectiveCellResult): string {
    return `${cell.caseId}:${cell.model}:${cell.seed}:${cell.platform}`;
}

function identity(cell: ProspectiveCellResult): string {
    return `${coordinate(cell)}:${cell.releaseRole}`;
}

type PairedArms = readonly [ProspectiveCellResult, ProspectiveCellResult];

function pairAt(cells: Map<string, ProspectiveCellResult> | undefined, key: string): PairedArms | undefined {
    const releaseN = cells?.get(`${key}:release-n`);
    const releaseNMinus1 = cells?.get(`${key}:release-n-minus-1`);
    return releaseN && releaseNMinus1 ? [releaseN, releaseNMinus1] : undefined;
}

function isCompletePair(pair: PairedArms): boolean {
    return pair[0].runHealth === "completed" && pair[1].runHealth === "completed";
}

function expectedCoordinates(close: CohortCloseManifest, freeze: ReleaseFreezeManifest): string[] {
    return close.body.cases.flatMap((entry) =>
        freeze.body.executionMatrix.models.flatMap((model) =>
            freeze.body.executionMatrix.seeds.flatMap((seed) =>
                freeze.body.executionMatrix.platforms.map((platform) =>
                    `${entry.caseId}:${model}:${seed}:${platform}`
                )
            )
        )
    );
}

function assertFrozenCell(cell: ProspectiveCellResult, freeze: ReleaseFreezeManifest): void {
    const frozenRelease = freeze.body.releases.find((release) => release.role === cell.releaseRole)!;
    if (
        cell.expectedReleaseId !== frozenRelease.releaseId ||
        cell.releaseRootManifestFingerprint !== frozenRelease.releaseRootManifestFingerprint ||
        cell.releaseIdentityFingerprint !== canonicalFingerprint(frozenRelease) ||
        !freeze.body.executionMatrix.models.includes(cell.model) ||
        !freeze.body.executionMatrix.seeds.includes(cell.seed) ||
        !freeze.body.executionMatrix.platforms.includes(cell.platform)
    ) {
        throw new HoldoutContractError(["comparison: frozen-release-binding-mismatch"]);
    }
}

export function buildPairedFacts(
    close: CohortCloseManifest,
    attempts: readonly CellAttempt[],
    aaPairs: readonly AaPair[],
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
    const expectedAa = new Set(expectedCoordinates(close, freeze));
    for (const pair of aaPairs) {
        if (!admitted.has(pair.left.caseId)) throw new HoldoutContractError(["comparison: unadmitted-aa-cell"]);
        assertFrozenCell(pair.left, freeze);
        assertFrozenCell(pair.right, freeze);
        const key = coordinate(pair.left);
        if (
            coordinate(pair.right) !== key ||
            pair.left.releaseRole !== pair.right.releaseRole ||
            !expectedAa.delete(key)
        ) {
            throw new HoldoutContractError(["comparison: aa-binding-mismatch"]);
        }
        assertAaSymmetry(pair.left, pair.right);
    }
    if (expectedAa.size > 0) throw new HoldoutContractError(["comparison: aa-evidence-incomplete"]);

    const byAttempt = new Map<number, Map<string, ProspectiveCellResult>>();
    for (const item of attempts) {
        if (!Number.isSafeInteger(item.attempt) || item.attempt < 0 || item.attempt > pairedRetryLimit) {
            throw new HoldoutContractError(["comparison: attempt-invalid"]);
        }
        if (!admitted.has(item.cell.caseId)) throw new HoldoutContractError(["comparison: unadmitted-cell"]);
        assertFrozenCell(item.cell, freeze);
        const cells = byAttempt.get(item.attempt) ?? new Map<string, ProspectiveCellResult>();
        const key = identity(item.cell);
        if (cells.has(key)) throw new HoldoutContractError(["comparison: duplicate-cell"]);
        cells.set(key, item.cell);
        byAttempt.set(item.attempt, cells);
    }
    const coordinates = expectedCoordinates(close, freeze);
    for (const [attempt, cells] of byAttempt) {
        for (const key of coordinates) {
            const left = cells.has(`${key}:release-n`);
            const right = cells.has(`${key}:release-n-minus-1`);
            if (left !== right) {
                throw new HoldoutContractError([`comparison: unpaired-retry-${attempt}`]);
            }
        }
    }
    const facts: PairedCaseFact[] = [];
    for (const key of coordinates) {
        const [caseId] = key.split(":", 1);
        const closed = admitted.get(caseId)!;
        const committedAttempts: number[] = [];
        const committed: PairedArms[] = [];
        for (let attempt = 0; attempt <= pairedRetryLimit; attempt += 1) {
            const pair = pairAt(byAttempt.get(attempt), key);
            if (pair) {
                committedAttempts.push(attempt);
                committed.push(pair);
            }
        }
        if (committed.length === 0) throw new HoldoutContractError(["comparison: missing-pair"]);
        // Committed attempts must be contiguous from 0; holes are invalid retry indices.
        if (committedAttempts.some((attempt, index) => attempt !== index)) {
            throw new HoldoutContractError(["comparison: attempt-invalid"]);
        }
        // A later attempt would replace the settled outcome.
        if (committed.slice(0, -1).some(isCompletePair)) {
            throw new HoldoutContractError(["comparison: retry-after-completion"]);
        }
        // The final attempt carries the coordinate's outcome.
        const chosen = committed[committed.length - 1]!;
        const [releaseN, releaseNMinus1] = chosen;
        if (
            releaseN.familyId !== closed.familyId ||
            releaseNMinus1.familyId !== closed.familyId ||
            releaseN.implementationFingerprint !== releaseNMinus1.implementationFingerprint ||
            releaseN.harness !== releaseNMinus1.harness
        ) {
            throw new HoldoutContractError(["comparison: pair-binding-mismatch"]);
        }
        facts.push({
            caseId,
            familyId: closed.familyId,
            implementationFingerprint: releaseN.implementationFingerprint,
            model: releaseN.model,
            seed: releaseN.seed,
            platform: releaseN.platform,
            releaseN,
            releaseNMinus1,
            status: isCompletePair(chosen) ? "complete" : "incomplete",
        });
    }
    return facts.sort(comparePairedFacts);
}

// Locale-dependent ordering and `:`-joined keys both let equal-ranking inputs decide order, so each field is compared in sequence.
export function comparePairedFacts(left: PairedCaseFact, right: PairedCaseFact): number {
    return compareCodeUnits(left.caseId, right.caseId) ||
        compareCodeUnits(left.model, right.model) ||
        compareCodeUnits(`${left.seed}`, `${right.seed}`) ||
        compareCodeUnits(left.platform, right.platform);
}

export function assertAaSymmetry(left: ProspectiveCellResult, right: ProspectiveCellResult): void {
    const projection = (cell: ProspectiveCellResult) => ({
        caseId: cell.caseId,
        familyId: cell.familyId,
        releaseRole: cell.releaseRole,
        expectedReleaseId: cell.expectedReleaseId,
        root: cell.observedRootFingerprint,
        releaseRootManifestFingerprint: cell.releaseRootManifestFingerprint,
        implementation: cell.implementationFingerprint,
        harness: cell.harness,
        model: cell.model,
        seed: cell.seed,
        platform: cell.platform,
        health: cell.runHealth,
        outcome: cell.productOutcome,
        // The projection is compared as serialized text, so listing order would decide symmetry.
        // A sorted copy makes symmetry independent of `failedChecks` order.
        checks: [...cell.failedChecks].sort(),
        reason: cell.reasonCode,
    });
    if (JSON.stringify(projection(left)) !== JSON.stringify(projection(right))) {
        throw new HoldoutContractError(["comparison: aa-asymmetry"]);
    }
}
