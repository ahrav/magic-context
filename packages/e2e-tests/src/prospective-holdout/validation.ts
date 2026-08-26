import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
    canonicalFingerprint,
    readCanonicalJsonFile,
} from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import { scanForSensitiveContent } from "../../../plugin/scripts/retrieval-benchmark/privacy";
import { HoldoutContractError, exact, record } from "./contract";
import {
    loadClose,
    loadFreeze,
    loadPolicyDocuments,
    readTrustedManifestRegistry,
    trustedFingerprint,
    validateTrustedLifecycle,
} from "./freeze";
import { parseLifecycleLedger, validateLifecycle, type LifecycleEvent } from "./lifecycle";
import { parseProspectiveCellResult, type ProspectiveCellResult } from "./runner";
import { parseAdjudicationClose } from "./adjudication";
import { buildPairedFacts, type AaPair, type PairedCaseFact } from "./comparison";
import {
    parseProspectiveReport,
    validateProspectiveReportEvidence,
    type ReportRecomputers,
} from "./report";
import {
    parseGraduationCandidate,
    validateGraduationBindings,
    validateGraduationCompleteness,
} from "./graduation";
import { parseIncidentCatalog, parseSourceInventory } from "../incident-pool/contract";
import { verifyProspectiveSourceEvidence } from "../incident-pool/evidence";
import { builtinIncidentCaseRegistry } from "../incident-pool/registry";

export interface HoldoutValidationResult {
    epochCount: number;
    states: Record<string, string>;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function canonicalFile(path: string, label: string): JsonValue {
    return readCanonicalJsonFile(
        path,
        (code) => new HoldoutContractError([`${label}:${code}`]),
    ) as JsonValue;
}

function parseJsonFile<T>(path: string, label: string, parse: (raw: unknown) => T): T {
    try {
        return parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch (error) {
        if (error instanceof HoldoutContractError) throw error;
        throw new HoldoutContractError([`${label}: unreadable`]);
    }
}

function lifecycleFile(path: string): LifecycleEvent[] {
    try {
        return parseLifecycleLedger(readFileSync(path, "utf8"));
    } catch (error) {
        if (error instanceof HoldoutContractError) throw error;
        throw new HoldoutContractError(["lifecycle: unreadable"]);
    }
}

interface ProspectiveOutcomes {
    attempts: Array<{ attempt: number; cell: ProspectiveCellResult }>;
    aa: AaPair[];
}

function parseOutcomes(raw: unknown): ProspectiveOutcomes {
    const value = record(raw, "outcomes");
    exact(value, ["schema", "attempts", "aa"], "outcomes");
    if (value.schema !== "prospective-outcomes/v1" || !Array.isArray(value.attempts) || !Array.isArray(value.aa)) {
        throw new HoldoutContractError(["outcomes: schema-invalid"]);
    }
    const attempts = value.attempts.map((entry, index) => {
        const item = record(entry, `outcomes.attempts[${index}]`);
        exact(item, ["attempt", "cell"], `outcomes.attempts[${index}]`);
        if (!Number.isSafeInteger(item.attempt) || (item.attempt as number) < 0) {
            throw new HoldoutContractError([`outcomes.attempts[${index}].attempt: invalid`]);
        }
        return { attempt: item.attempt as number, cell: parseProspectiveCellResult(item.cell) };
    });
    const aa = value.aa.map((entry, index) => {
        const item = record(entry, `outcomes.aa[${index}]`);
        exact(item, ["left", "right"], `outcomes.aa[${index}]`);
        return {
            left: parseProspectiveCellResult(item.left),
            right: parseProspectiveCellResult(item.right),
        };
    });
    return { attempts, aa };
}

function requiredEvent(events: readonly LifecycleEvent[], state: LifecycleEvent["state"]): LifecycleEvent | undefined {
    return events.find((event) => event.state === state);
}

function pairedRetryLimit(rawPolicy: unknown): number {
    const policy = record(rawPolicy, "policy.analysis.policy");
    if (!Number.isSafeInteger(policy.pairedRetryLimit) || (policy.pairedRetryLimit as number) < 0) {
        throw new HoldoutContractError(["policy.analysis.policy.pairedRetryLimit: invalid"]);
    }
    return policy.pairedRetryLimit as number;
}

export function validateHoldoutRepository(
    e2eRoot: string,
    recomputers?: ReportRecomputers,
): HoldoutValidationResult {
    const holdoutRoot = join(e2eRoot, "prospective-holdout");
    const policies = loadPolicyDocuments(
        join(holdoutRoot, "policies", "analysis-policy.json"),
        join(holdoutRoot, "policies", "scorecard-policy.json"),
    );
    const trust = readTrustedManifestRegistry(join(holdoutRoot, "trusted-manifests.jsonl"));
    const epochsRoot = join(holdoutRoot, "epochs");
    const epochNames = existsSync(epochsRoot) ? readdirSync(epochsRoot).sort() : [];
    if (epochNames.length === 0) {
        if (trust.length > 0) throw new HoldoutContractError(["trust-registry: entries-without-epochs"]);
        return { epochCount: 0, states: {} };
    }
    if (policies.analysis.status !== "ready" || policies.scorecard.status !== "ready") {
        throw new HoldoutContractError(["epochs: sibling-policy-pending"]);
    }
    const states: Record<string, string> = {};
    const expectedTrustEntries = new Set<string>();
    for (const epochId of epochNames) {
        expectedTrustEntries.add(`${epochId}:freeze`);
        expectedTrustEntries.add(`${epochId}:lifecycle`);
        const epochRoot = join(epochsRoot, epochId);
        if (!lstatSync(epochRoot).isDirectory() || lstatSync(epochRoot).isSymbolicLink()) {
            throw new HoldoutContractError(["epochs: irregular-entry"]);
        }
        const events = lifecycleFile(join(epochRoot, "lifecycle.jsonl"));
        const lifecycle = validateLifecycle(events, { epochId });
        validateTrustedLifecycle(trust, epochId, events);
        const freeze = loadFreeze(
            join(epochRoot, "freeze"),
            trustedFingerprint(trust, epochId, "freeze"),
            policies,
        );
        if (events[0]!.artifactFingerprint !== freeze.manifestFingerprint) {
            throw new HoldoutContractError(["lifecycle: freeze-artifact-mismatch"]);
        }
        const expectedEntries = new Set(["freeze", "lifecycle.jsonl"]);
        const closeEvent = requiredEvent(events, "cohort-closed");
        let close: ReturnType<typeof loadClose> | undefined;
        if (closeEvent || requiredEvent(events, "running") || requiredEvent(events, "reported") || requiredEvent(events, "insufficient-evidence") || requiredEvent(events, "graduated")) {
            expectedEntries.add("close");
            expectedTrustEntries.add(`${epochId}:close`);
            close = loadClose(
                join(epochRoot, "close"),
                trustedFingerprint(trust, epochId, "close"),
                freeze,
            );
            if (closeEvent && closeEvent.artifactFingerprint !== close.manifestFingerprint) {
                throw new HoldoutContractError(["lifecycle: close-artifact-mismatch"]);
            }
        }
        const runningEvent = requiredEvent(events, "running");
        let outcomes: ProspectiveOutcomes = { attempts: [], aa: [] };
        if (runningEvent || requiredEvent(events, "reported") || requiredEvent(events, "insufficient-evidence") || requiredEvent(events, "graduated")) {
            expectedEntries.add("outcomes.json");
            const raw = canonicalFile(join(epochRoot, "outcomes.json"), "outcomes");
            const violations = scanForSensitiveContent(raw);
            if (violations.length > 0) throw new HoldoutContractError(["outcomes: privacy-rejected"]);
            outcomes = parseOutcomes(raw);
            if (runningEvent && runningEvent.artifactFingerprint !== canonicalFingerprint(raw)) {
                throw new HoldoutContractError(["lifecycle: outcomes-artifact-mismatch"]);
            }
        }
        const reportEvent = requiredEvent(events, "reported") ?? requiredEvent(events, "insufficient-evidence");
        let report: ReturnType<typeof parseProspectiveReport> | undefined;
        let pairs: PairedCaseFact[] = [];
        if (reportEvent || requiredEvent(events, "graduated")) {
            expectedEntries.add("report.json");
            expectedTrustEntries.add(`${epochId}:report`);
            const raw = canonicalFile(join(epochRoot, "report.json"), "report");
            if (canonicalFingerprint(raw) !== trustedFingerprint(trust, epochId, "report")) {
                throw new HoldoutContractError(["report: untrusted"]);
            }
            report = parseProspectiveReport(raw);
            if (
                !close ||
                report.body.epochId !== epochId ||
                report.body.freezeManifestFingerprint !== freeze.manifestFingerprint ||
                report.body.closeManifestFingerprint !== close.manifestFingerprint ||
                report.body.analysisPolicyFingerprint !== policies.analysis.policyFingerprint ||
                report.body.scorecardPolicyFingerprint !== policies.scorecard.policyFingerprint ||
                reportEvent?.artifactFingerprint !== report.reportFingerprint
            ) {
                throw new HoldoutContractError(["report: epoch-binding-invalid"]);
            }
            pairs = buildPairedFacts(
                close.manifest,
                outcomes.attempts,
                outcomes.aa,
                pairedRetryLimit(policies.analysis.policy),
                freeze.manifest,
            );
            if (!recomputers) {
                throw new HoldoutContractError(["report: sibling-recomputers-required"]);
            }
            validateProspectiveReportEvidence(report, pairs, recomputers);
            const insufficientEvidence = report.body.decision === "insufficient-evidence";
            if (insufficientEvidence !== (reportEvent?.state === "insufficient-evidence")) {
                throw new HoldoutContractError(["report: lifecycle-state-mismatch"]);
            }
            if (close.manifest.body.cases.some((entry) => entry.subjective)) {
                expectedEntries.add("adjudication-close.json");
                expectedTrustEntries.add(`${epochId}:adjudication-close`);
                const adjudicationRaw = canonicalFile(join(epochRoot, "adjudication-close.json"), "adjudication-close");
                if (canonicalFingerprint(adjudicationRaw) !== trustedFingerprint(trust, epochId, "adjudication-close")) {
                    throw new HoldoutContractError(["adjudication-close: untrusted"]);
                }
                const adjudicationClose = parseAdjudicationClose(adjudicationRaw);
                if (
                    adjudicationClose.epochId !== epochId ||
                    adjudicationClose.closeManifestFingerprint !== close.manifestFingerprint ||
                    adjudicationClose.subjectiveMapCommitment !== close.manifest.body.subjectiveMapCommitment ||
                    adjudicationClose.judgmentCount !== close.manifest.body.cases.filter((entry) => entry.subjective).length
                ) {
                    throw new HoldoutContractError(["adjudication-close: cohort-binding-invalid"]);
                }
                // The cohort manifest fixes the case set the judgments cover, so a close
                // stamped before it claims verdicts over cases intake could still admit.
                // The same instant is legal: the cohort is fixed at that point.
                if (Date.parse(adjudicationClose.closedAt) < Date.parse(close.manifest.body.closedAt)) {
                    throw new HoldoutContractError(["adjudication-close.closedAt: before-cohort-close"]);
                }
            }
        }
        const graduatedEvent = requiredEvent(events, "graduated");
        if (graduatedEvent) {
            if (!close || !report) throw new HoldoutContractError(["graduation: prior-artifacts-missing"]);
            expectedEntries.add("graduation");
            const directory = join(epochRoot, "graduation");
            // Every other failure here carries a stable diagnostic code, so a ledger that
            // claims graduation without the directory must not surface as a raw ENOENT.
            if (!existsSync(directory)) {
                throw new HoldoutContractError(["graduation: directory-missing"]);
            }
            const files = readdirSync(directory).sort();
            const candidates = files.map((file) => {
                if (!/^case-[0-9a-f]{32}\.json$/.test(file)) {
                    throw new HoldoutContractError(["graduation: filename-invalid"]);
                }
                const candidate = parseGraduationCandidate(canonicalFile(join(directory, file), "graduation"));
                verifyProspectiveSourceEvidence(
                    candidate.source,
                    close!.manifest,
                    close!.manifestFingerprint,
                    candidate.incidentBytes,
                );
                return candidate;
            });
            validateGraduationCompleteness(close.manifest, candidates);
            validateGraduationBindings(
                candidates,
                pairs,
                parseJsonFile(join(e2eRoot, "incidents", "source-inventory.json"), "graduation.inventory", parseSourceInventory),
                parseJsonFile(join(e2eRoot, "incidents", "catalog.json"), "graduation.catalog", parseIncidentCatalog),
                builtinIncidentCaseRegistry(),
                join(e2eRoot, "../.."),
            );
            if (graduatedEvent.artifactFingerprint !== canonicalFingerprint(candidates)) {
                throw new HoldoutContractError(["lifecycle: graduation-artifact-mismatch"]);
            }
        }
        const actualEntries = readdirSync(epochRoot).sort();
        if (
            actualEntries.length !== expectedEntries.size ||
            actualEntries.some((entry) => !expectedEntries.has(entry))
        ) {
            throw new HoldoutContractError(["epoch: artifact-set-invalid"]);
        }
        if (close) {
            // A freeze may declare several models, seeds, and platforms. Keying selection on
            // case and release role alone would let one pair satisfy the whole matrix and
            // drive a promotion while every other frozen configuration stayed unexecuted, so
            // the expected set is the full cross product the freeze committed to.
            const matrix = freeze.manifest.body.executionMatrix;
            const coordinates = close.manifest.body.cases.flatMap((entry) =>
                matrix.models.flatMap((model) =>
                    matrix.seeds.flatMap((seed) =>
                        matrix.platforms.map((platform) => `${entry.caseId}:${model}:${seed}:${platform}`)
                    )
                )
            );
            const selectedCells = new Set(coordinates.flatMap((coordinate) => [
                `${coordinate}:release-n`, `${coordinate}:release-n-minus-1`,
            ]));
            const expectedCells = new Set(selectedCells);
            const seenAttempts = new Set<string>();
            const cellKey = (cell: ProspectiveCellResult): string =>
                `${cell.caseId}:${cell.model}:${cell.seed}:${cell.platform}:${cell.releaseRole}`;
            for (const attempt of outcomes.attempts) {
                const cell = cellKey(attempt.cell);
                if (!selectedCells.has(cell)) throw new HoldoutContractError(["outcomes: unselected-cell"]);
                const attemptCell = `${attempt.attempt}:${cell}`;
                if (seenAttempts.has(attemptCell)) throw new HoldoutContractError(["outcomes: duplicate-cell"]);
                seenAttempts.add(attemptCell);
                expectedCells.delete(cell);
            }
            for (const pair of outcomes.aa) {
                if (!selectedCells.has(cellKey(pair.left)) || !selectedCells.has(cellKey(pair.right))) {
                    throw new HoldoutContractError(["outcomes: unselected-aa-cell"]);
                }
            }
            if (outcomes.attempts.length > 0 && expectedCells.size > 0) {
                throw new HoldoutContractError(["outcomes: selected-matrix-incomplete"]);
            }
        }
        states[epochId] = lifecycle.state;
    }
    const knownEpochs = new Set(epochNames);
    if (trust.some((entry) => !knownEpochs.has(entry.epochId))) {
        throw new HoldoutContractError(["trust-registry: unknown-epoch"]);
    }
    const actualTrustEntries = new Set(trust.map((entry) => `${entry.epochId}:${entry.kind}`));
    if (
        actualTrustEntries.size !== expectedTrustEntries.size ||
        [...actualTrustEntries].some((entry) => !expectedTrustEntries.has(entry))
    ) {
        throw new HoldoutContractError(["trust-registry: artifact-set-invalid"]);
    }
    return { epochCount: epochNames.length, states };
}
