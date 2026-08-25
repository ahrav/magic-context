/**
 * Versioned, catalog-bound incident pool report (U2, KTD8, KTD10, R8, R13).
 *
 * Structural completeness (allowlisted facts, selected-set digest, expected
 * count, exactly one terminal result per selected variant, completion
 * marker, atomic publication) is separate from evaluation completeness
 * (every result completed and scored). The CLI exit policy lives here too:
 * only incompleteness matching a reviewed blocked_by dependency leaves the
 * incident command successful.
 *
 * Every field is a closed enum, static allowlisted id, or hex digest —
 * raw process output, stack traces, and fixture data cannot ride a report.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
    ADJUDICATION_EVENT_ID_RE,
    BASELINE_VERDICTS,
    CHECK_ID_RE,
    FAMILY_ID_RE,
    HARNESSES,
    SEMANTIC_REVISION_ID_RE,
    VARIANT_ID_RE,
    type BaselineVerdict,
    type Harness,
} from "./contract";

export const INCIDENT_REPORT_SCHEMA = "incident-pool-report/v1";
export const SCHEDULED_INCIDENT_REPORT_SCHEMA =
    "incident-pool-scheduled-report/v1";
export const INCIDENT_MODES = ["ts", "rust"] as const;
export type IncidentMode = (typeof INCIDENT_MODES)[number];

export const RUN_HEALTHS = [
    "completed",
    "timeout",
    "crash",
    "unavailable",
    "malformed",
] as const;
export type RunHealth = (typeof RUN_HEALTHS)[number];

export const BEHAVIORAL_VERDICTS = [
    "pass",
    "assertion_fail",
    "not_evaluated",
] as const;
export type BehavioralVerdict = (typeof BEHAVIORAL_VERDICTS)[number];

export const BASELINE_COMPARISONS = [
    "expected_green",
    "regression",
    "expected_red",
    "unexpected_failure",
    "resolution_candidate",
    "unscored",
] as const;
export type BaselineComparison = (typeof BASELINE_COMPARISONS)[number];

/** Closed static reason vocabulary — never derived from process output. */
export const RESULT_REASON_CODES = [
    "deadline_exceeded",
    "exited_without_envelope",
    "invalid_envelope",
    "snapshot_mismatch",
    "duplicate_envelope",
    "envelope_oversized",
    "prerequisite_missing",
    "blocked_by_dependency",
    "precondition_unmet",
] as const;
export type ResultReasonCode = (typeof RESULT_REASON_CODES)[number];

export const RESULT_LANES = ["green", "known-red"] as const;
export type ResultLane = (typeof RESULT_LANES)[number];

export interface IncidentCaseResult {
    family_id: string;
    variant_id: string;
    lane: ResultLane;
    semantic_revision_id: string;
    semantic_fingerprint: string;
    implementation_digest: string;
    baseline_event_id: string;
    baseline_verdict: BaselineVerdict;
    run_health: RunHealth;
    behavioral_verdict: BehavioralVerdict;
    baseline_comparison: BaselineComparison;
    failed_checks: string[];
    observation_signature: string | null;
    blocked_by: string[];
    reason_code: ResultReasonCode | null;
}

export interface IncidentPoolReport {
    schema: typeof INCIDENT_REPORT_SCHEMA;
    run_nonce: string;
    harness: Harness;
    ledger_fingerprint: string;
    selected_set_digest: string;
    expected_count: number;
    family_count: number;
    variant_count: number;
    results: IncidentCaseResult[];
    evaluation_complete: boolean;
    completion_marker: true;
}

// ---------------------------------------------------------------------------
// Strict parsing helpers. contract.ts keeps its own copies private, so the
// report/runner layer carries this small mirror rather than widening the U1
// contract surface (see U2 report note).
// ---------------------------------------------------------------------------

export function fail(label: string, message: string): never {
    throw new Error(`${label}: ${message}`);
}

export function asRecord(
    value: unknown,
    label: string,
): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(label, "must be an object");
    }
    return value as Record<string, unknown>;
}

export function requireExactKeys(
    record: Record<string, unknown>,
    keys: readonly string[],
    label: string,
): void {
    const actual = Object.keys(record).sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
    );
    const expected = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (
        actual.length !== expected.length ||
        actual.some((key, i) => key !== expected[i])
    ) {
        fail(
            label,
            `must contain exactly ${expected.join(", ")}; got ${actual.join(", ") || "no keys"}`,
        );
    }
}

export function asEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    label: string,
): T {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
        fail(label, `must be one of ${allowed.join(", ")}`);
    }
    return value as T;
}

export function asId(value: unknown, re: RegExp, label: string): string {
    if (typeof value !== "string" || !re.test(value)) {
        fail(label, `must be a static id matching ${re.source}`);
    }
    return value;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
export function asHex64(value: unknown, label: string): string {
    if (typeof value !== "string" || !HEX64_RE.test(value)) {
        fail(label, "must be a lowercase sha-256 hex digest");
    }
    return value;
}

const RUN_NONCE_RE = /^[0-9a-f]{32}$/;
export function asRunNonce(value: unknown, label: string): string {
    if (typeof value !== "string" || !RUN_NONCE_RE.test(value)) {
        fail(label, "must be a 32-char lowercase hex run nonce");
    }
    return value;
}

export function newRunNonce(): string {
    return randomBytes(16).toString("hex");
}

export function asIdArray(value: unknown, re: RegExp, label: string): string[] {
    if (!Array.isArray(value)) fail(label, "must be an array");
    const ids = value.map((entry, i) => asId(entry, re, `${label}[${i}]`));
    if (new Set(ids).size !== ids.length)
        fail(label, "must not contain duplicates");
    return ids;
}

function asCount(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        fail(label, "must be a non-negative integer");
    }
    return value;
}

// ---------------------------------------------------------------------------
// Result validation: the closed cross-field contract of the three orthogonal
// dimensions (KTD8). Only a completed run with satisfied preconditions may
// carry pass/assertion_fail or a scored comparison.
// ---------------------------------------------------------------------------

const UNHEALTHY_REASONS: Record<
    Exclude<RunHealth, "completed">,
    readonly ResultReasonCode[]
> = {
    timeout: ["deadline_exceeded"],
    crash: ["exited_without_envelope"],
    unavailable: ["prerequisite_missing"],
    malformed: [
        "invalid_envelope",
        "snapshot_mismatch",
        "duplicate_envelope",
        "envelope_oversized",
    ],
};

export function validateCaseResult(
    result: IncidentCaseResult,
    label: string,
): void {
    const expectedBaseline: BaselineVerdict =
        result.lane === "green" ? "green" : "red";
    if (result.baseline_verdict !== expectedBaseline) {
        fail(
            label,
            `lane ${result.lane} disagrees with baseline verdict ${result.baseline_verdict}`,
        );
    }

    if (result.run_health !== "completed") {
        if (
            result.behavioral_verdict !== "not_evaluated" ||
            result.baseline_comparison !== "unscored"
        ) {
            fail(
                label,
                `${result.run_health} run must be not_evaluated and unscored`,
            );
        }
        const allowed = UNHEALTHY_REASONS[result.run_health];
        if (
            result.reason_code === null ||
            !allowed.includes(result.reason_code)
        ) {
            fail(
                label,
                `${result.run_health} run requires a reason code in ${allowed.join(", ")}`,
            );
        }
        if (
            result.failed_checks.length !== 0 ||
            result.observation_signature !== null ||
            result.blocked_by.length !== 0
        ) {
            fail(
                label,
                `${result.run_health} run must not carry checks, signatures, or dependencies`,
            );
        }
        return;
    }

    switch (result.behavioral_verdict) {
        case "not_evaluated": {
            if (result.baseline_comparison !== "unscored") {
                fail(label, "not_evaluated result must be unscored");
            }
            if (
                result.failed_checks.length !== 0 ||
                result.observation_signature !== null
            ) {
                fail(
                    label,
                    "not_evaluated result must not carry checks or signatures",
                );
            }
            if (result.reason_code === "blocked_by_dependency") {
                if (result.blocked_by.length === 0) {
                    fail(
                        label,
                        "blocked_by_dependency requires at least one reviewed dependency",
                    );
                }
            } else if (result.reason_code === "precondition_unmet") {
                if (result.blocked_by.length !== 0) {
                    fail(
                        label,
                        "precondition_unmet must not carry dependencies",
                    );
                }
            } else {
                fail(
                    label,
                    "completed not_evaluated result requires blocked_by_dependency or precondition_unmet",
                );
            }
            return;
        }
        case "pass": {
            if (
                result.failed_checks.length !== 0 ||
                result.observation_signature !== null
            ) {
                fail(
                    label,
                    "pass must not carry failed checks or an observation signature",
                );
            }
            const expected =
                result.baseline_verdict === "green"
                    ? "expected_green"
                    : "resolution_candidate";
            if (result.baseline_comparison !== expected) {
                fail(
                    label,
                    `pass on a ${result.baseline_verdict} baseline must compare as ${expected}`,
                );
            }
            break;
        }
        case "assertion_fail": {
            if (result.failed_checks.length === 0) {
                fail(
                    label,
                    "assertion_fail requires at least one failed check",
                );
            }
            asHex64(
                result.observation_signature,
                `${label}.observation_signature`,
            );
            if (result.baseline_verdict === "green") {
                if (result.baseline_comparison !== "regression") {
                    fail(
                        label,
                        "assertion_fail on a green baseline must compare as regression",
                    );
                }
            } else if (
                result.baseline_comparison !== "expected_red" &&
                result.baseline_comparison !== "unexpected_failure"
            ) {
                fail(
                    label,
                    "assertion_fail on a red baseline must compare as expected_red or unexpected_failure",
                );
            }
            break;
        }
    }
    if (result.reason_code !== null || result.blocked_by.length !== 0) {
        fail(
            label,
            "an evaluated result must not carry a reason code or dependencies",
        );
    }
}

export function parseCaseResult(
    raw: unknown,
    label: string,
): IncidentCaseResult {
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        [
            "family_id",
            "variant_id",
            "lane",
            "semantic_revision_id",
            "semantic_fingerprint",
            "implementation_digest",
            "baseline_event_id",
            "baseline_verdict",
            "run_health",
            "behavioral_verdict",
            "baseline_comparison",
            "failed_checks",
            "observation_signature",
            "blocked_by",
            "reason_code",
        ],
        label,
    );
    const result: IncidentCaseResult = {
        family_id: asId(record.family_id, FAMILY_ID_RE, `${label}.family_id`),
        variant_id: asId(
            record.variant_id,
            VARIANT_ID_RE,
            `${label}.variant_id`,
        ),
        lane: asEnum(record.lane, RESULT_LANES, `${label}.lane`),
        semantic_revision_id: asId(
            record.semantic_revision_id,
            SEMANTIC_REVISION_ID_RE,
            `${label}.semantic_revision_id`,
        ),
        semantic_fingerprint: asHex64(
            record.semantic_fingerprint,
            `${label}.semantic_fingerprint`,
        ),
        implementation_digest: asHex64(
            record.implementation_digest,
            `${label}.implementation_digest`,
        ),
        baseline_event_id: asId(
            record.baseline_event_id,
            ADJUDICATION_EVENT_ID_RE,
            `${label}.baseline_event_id`,
        ),
        baseline_verdict: asEnum(
            record.baseline_verdict,
            BASELINE_VERDICTS,
            `${label}.baseline_verdict`,
        ),
        run_health: asEnum(
            record.run_health,
            RUN_HEALTHS,
            `${label}.run_health`,
        ),
        behavioral_verdict: asEnum(
            record.behavioral_verdict,
            BEHAVIORAL_VERDICTS,
            `${label}.behavioral_verdict`,
        ),
        baseline_comparison: asEnum(
            record.baseline_comparison,
            BASELINE_COMPARISONS,
            `${label}.baseline_comparison`,
        ),
        failed_checks: asIdArray(
            record.failed_checks,
            CHECK_ID_RE,
            `${label}.failed_checks`,
        ),
        observation_signature:
            record.observation_signature === null
                ? null
                : asHex64(
                      record.observation_signature,
                      `${label}.observation_signature`,
                  ),
        blocked_by: asIdArray(
            record.blocked_by,
            VARIANT_ID_RE,
            `${label}.blocked_by`,
        ),
        reason_code:
            record.reason_code === null
                ? null
                : asEnum(
                      record.reason_code,
                      RESULT_REASON_CODES,
                      `${label}.reason_code`,
                  ),
    };
    validateCaseResult(result, label);
    return result;
}

// ---------------------------------------------------------------------------
// Report construction and structural completeness.
// ---------------------------------------------------------------------------

export function isEvaluationComplete(result: IncidentCaseResult): boolean {
    return (
        result.run_health === "completed" &&
        result.behavioral_verdict !== "not_evaluated"
    );
}

export interface BuildReportInput {
    runNonce: string;
    harness: Harness;
    ledgerFingerprint: string;
    selectedSetDigest: string;
    selectedVariantIds: readonly string[];
    familyCount: number;
    results: readonly IncidentCaseResult[];
}

/**
 * Build a structurally complete report or throw: rejects an empty selection,
 * duplicate results, missing selected results, and unexpected unselected
 * results (exactly-one-terminal-result bijection, KTD10).
 */
export function buildIncidentReport(
    input: BuildReportInput,
): IncidentPoolReport {
    if (input.selectedVariantIds.length === 0) {
        fail(
            "report",
            "selection is empty; a zero-case run cannot be structurally complete",
        );
    }
    const selected = new Set(input.selectedVariantIds);
    if (selected.size !== input.selectedVariantIds.length) {
        fail("report", "selected set contains duplicate variant ids");
    }
    const seen = new Set<string>();
    for (const result of input.results) {
        validateCaseResult(result, `report.results(${result.variant_id})`);
        if (!selected.has(result.variant_id)) {
            fail(
                "report",
                `unexpected result for unselected variant ${result.variant_id}`,
            );
        }
        if (seen.has(result.variant_id)) {
            fail(
                "report",
                `duplicate terminal result for variant ${result.variant_id}`,
            );
        }
        seen.add(result.variant_id);
    }
    for (const variantId of selected) {
        if (!seen.has(variantId)) {
            fail(
                "report",
                `missing terminal result for selected variant ${variantId}`,
            );
        }
    }
    return {
        schema: INCIDENT_REPORT_SCHEMA,
        run_nonce: asRunNonce(input.runNonce, "report.run_nonce"),
        harness: input.harness,
        ledger_fingerprint: asHex64(
            input.ledgerFingerprint,
            "report.ledger_fingerprint",
        ),
        selected_set_digest: asHex64(
            input.selectedSetDigest,
            "report.selected_set_digest",
        ),
        expected_count: input.selectedVariantIds.length,
        family_count: input.familyCount,
        variant_count: input.selectedVariantIds.length,
        results: [...input.results],
        evaluation_complete: input.results.every(isEvaluationComplete),
        completion_marker: true,
    };
}

/** Exact-key parse; recomputes counts and the evaluation-completeness flag
 *  so a tampered or truncated report cannot claim completeness. */
export function parseIncidentReport(raw: unknown): IncidentPoolReport {
    const record = asRecord(raw, "report");
    requireExactKeys(
        record,
        [
            "schema",
            "run_nonce",
            "harness",
            "ledger_fingerprint",
            "selected_set_digest",
            "expected_count",
            "family_count",
            "variant_count",
            "results",
            "evaluation_complete",
            "completion_marker",
        ],
        "report",
    );
    if (record.schema !== INCIDENT_REPORT_SCHEMA)
        fail("report.schema", `must be ${INCIDENT_REPORT_SCHEMA}`);
    if (record.completion_marker !== true)
        fail("report.completion_marker", "must be exactly true");
    if (!Array.isArray(record.results))
        fail("report.results", "must be an array");
    const results = record.results.map((entry, i) =>
        parseCaseResult(entry, `report.results[${i}]`),
    );
    if (results.length === 0) fail("report.results", "must not be empty");
    const variantIds = new Set(results.map((result) => result.variant_id));
    if (variantIds.size !== results.length)
        fail("report.results", "duplicate variant results");
    const expectedCount = asCount(
        record.expected_count,
        "report.expected_count",
    );
    if (expectedCount !== results.length) {
        fail(
            "report.expected_count",
            `expected ${expectedCount} results, got ${results.length}`,
        );
    }
    if (
        asCount(record.variant_count, "report.variant_count") !== results.length
    ) {
        fail("report.variant_count", "must equal the terminal result count");
    }
    const familyCount = asCount(record.family_count, "report.family_count");
    if (
        familyCount !== new Set(results.map((result) => result.family_id)).size
    ) {
        fail(
            "report.family_count",
            "must equal the distinct family count of the results",
        );
    }
    const evaluationComplete = results.every(isEvaluationComplete);
    if (record.evaluation_complete !== evaluationComplete) {
        fail(
            "report.evaluation_complete",
            `must be ${evaluationComplete} for these results`,
        );
    }
    return {
        schema: INCIDENT_REPORT_SCHEMA,
        run_nonce: asRunNonce(record.run_nonce, "report.run_nonce"),
        harness: asEnum(record.harness, HARNESSES, "report.harness"),
        ledger_fingerprint: asHex64(
            record.ledger_fingerprint,
            "report.ledger_fingerprint",
        ),
        selected_set_digest: asHex64(
            record.selected_set_digest,
            "report.selected_set_digest",
        ),
        expected_count: expectedCount,
        family_count: familyCount,
        variant_count: results.length,
        results,
        evaluation_complete: evaluationComplete,
        completion_marker: true,
    };
}

function publishJsonAtomically(value: unknown, path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, `${JSON.stringify(value, null, 4)}\n`, {
        mode: 0o644,
    });
    renameSync(temp, path);
}

/** Atomic publication: write a temp file, then rename. An interrupted
 *  publication leaves no readable report at the target path. */
export function publishIncidentReport(
    report: IncidentPoolReport,
    path: string,
): void {
    publishJsonAtomically(report, path);
}

function readAndParse<T>(
    path: string,
    label: string,
    parse: (raw: unknown) => T,
): T {
    const text = readFileSync(path, "utf8");
    let raw: unknown;
    try {
        raw = JSON.parse(text) as unknown;
    } catch (error) {
        fail(
            label,
            `published report at ${path} is not valid JSON: ${String(error)}`,
        );
    }
    return parse(raw);
}

export function readIncidentReport(path: string): IncidentPoolReport {
    return readAndParse(path, "report", parseIncidentReport);
}

export interface ScheduledIncidentReport {
    schema: typeof SCHEDULED_INCIDENT_REPORT_SCHEMA;
    mode: IncidentMode;
    report_count: number;
    expected_count: number;
    family_count: number;
    variant_count: number;
    reports: IncidentPoolReport[];
    evaluation_complete: boolean;
    completion_marker: true;
}

function harnessSchedule(mode: IncidentMode): Harness[] {
    return mode === "ts" ? ["opencode", "pi"] : ["rust"];
}

export function buildScheduledIncidentReport(
    mode: IncidentMode,
    reports: IncidentPoolReport[],
): ScheduledIncidentReport {
    const schedule = harnessSchedule(mode);
    if (reports.length !== schedule.length) {
        fail(
            "scheduled report.reports",
            `mode ${mode} requires ${schedule.length} harness reports`,
        );
    }
    for (const [index, harness] of schedule.entries()) {
        if (reports[index]?.harness !== harness) {
            fail(
                `scheduled report.reports[${index}]`,
                `must be the ${harness} harness report`,
            );
        }
    }
    const results = reports.flatMap((report) => report.results);
    if (results.length === 0)
        fail("scheduled report.results", "must not be empty");
    const variantIds = new Set(results.map((result) => result.variant_id));
    if (variantIds.size !== results.length) {
        fail("scheduled report.results", "duplicate variant results");
    }
    return {
        schema: SCHEDULED_INCIDENT_REPORT_SCHEMA,
        mode,
        report_count: reports.length,
        expected_count: results.length,
        family_count: new Set(results.map((result) => result.family_id)).size,
        variant_count: results.length,
        reports,
        evaluation_complete: reports.every(
            (report) => report.evaluation_complete,
        ),
        completion_marker: true,
    };
}

export function parseScheduledIncidentReport(
    raw: unknown,
): ScheduledIncidentReport {
    const record = asRecord(raw, "scheduled report");
    requireExactKeys(
        record,
        [
            "schema",
            "mode",
            "report_count",
            "expected_count",
            "family_count",
            "variant_count",
            "reports",
            "evaluation_complete",
            "completion_marker",
        ],
        "scheduled report",
    );
    if (record.schema !== SCHEDULED_INCIDENT_REPORT_SCHEMA) {
        fail(
            "scheduled report.schema",
            `must be ${SCHEDULED_INCIDENT_REPORT_SCHEMA}`,
        );
    }
    if (record.completion_marker !== true) {
        fail("scheduled report.completion_marker", "must be exactly true");
    }
    if (!Array.isArray(record.reports)) {
        fail("scheduled report.reports", "must be an array");
    }
    const mode = asEnum(record.mode, INCIDENT_MODES, "scheduled report.mode");
    const reports = record.reports.map((entry) => parseIncidentReport(entry));
    const parsed = buildScheduledIncidentReport(mode, reports);
    for (const field of [
        "report_count",
        "expected_count",
        "family_count",
        "variant_count",
    ] as const) {
        const actual = asCount(record[field], `scheduled report.${field}`);
        if (actual !== parsed[field]) {
            fail(
                `scheduled report.${field}`,
                `must be ${parsed[field]} for these reports`,
            );
        }
    }
    if (record.evaluation_complete !== parsed.evaluation_complete) {
        fail(
            "scheduled report.evaluation_complete",
            `must be ${parsed.evaluation_complete} for these reports`,
        );
    }
    return parsed;
}

export function publishScheduledIncidentReport(
    report: ScheduledIncidentReport,
    path: string,
): void {
    publishJsonAtomically(report, path);
}

export function readScheduledIncidentReport(
    path: string,
): ScheduledIncidentReport {
    return readAndParse(path, "scheduled report", parseScheduledIncidentReport);
}

// ---------------------------------------------------------------------------
// CLI exit policy (KTD10): evaluation incompleteness is acceptable only when
// every incomplete result matches a reviewed blocked_by dependency.
// ---------------------------------------------------------------------------

export function unexpectedIncompleteResults(
    report: IncidentPoolReport,
): IncidentCaseResult[] {
    return report.results.filter(
        (result) =>
            !isEvaluationComplete(result) &&
            !(
                result.reason_code === "blocked_by_dependency" &&
                result.blocked_by.length > 0
            ),
    );
}

export function incidentPoolExitCode(report: IncidentPoolReport): number {
    return unexpectedIncompleteResults(report).length === 0 ? 0 : 1;
}

export function scheduledIncidentExitCode(
    report: ScheduledIncidentReport,
): number {
    return report.reports.every((entry) => incidentPoolExitCode(entry) === 0)
        ? 0
        : 1;
}
