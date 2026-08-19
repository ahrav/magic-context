import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    dueReadyReason,
    lifecycleStateFromNote,
    reduceSmartNoteEvaluation,
    type SmartNoteEvaluationOutcome,
    type SmartNoteLifecycleState,
} from "./evaluation-state";

interface GoldenLifecycle {
    status: string;
    ready_at: number | null;
    ready_reason: string | null;
    last_checked_at: number | null;
    updated_at: number;
    compiled_check: string | null;
    manifest_json: string | null;
    check_hash: string | null;
    check_cron: string | null;
    check_version: number;
    check_status: string;
    check_failure_count: number;
    check_network_failure_count: number;
    check_quarantined_until: number | null;
    check_next_due_at: number | null;
    check_compiled_at: number | null;
    check_false_since_at: number | null;
    check_last_liveness_at: number | null;
    policy_version: number;
}

interface GoldenTransitionCase {
    id: string;
    phase: "compile" | "due" | "liveness" | "fallback";
    outcome: {
        kind: string;
        compiled_check?: string;
        manifest_json?: string;
        check_hash?: string;
        check_cron?: string;
    };
    note_id: number;
    now: number;
    pre: GoldenLifecycle;
    expected: GoldenLifecycle;
}

const goldenPath = join(
    import.meta.dir,
    "../../../../../../crates/mc-module/testdata/smart-note-evaluation-golden.json",
);
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
    transition_cases: GoldenTransitionCase[];
};

function toState(row: GoldenLifecycle): SmartNoteLifecycleState {
    return lifecycleStateFromNote({
        status: row.status,
        readyAt: row.ready_at,
        readyReason: row.ready_reason,
        lastCheckedAt: row.last_checked_at,
        updatedAt: row.updated_at,
        compiledCheck: row.compiled_check,
        manifestJson: row.manifest_json,
        checkHash: row.check_hash,
        checkCron: row.check_cron,
        checkVersion: row.check_version,
        checkStatus: row.check_status as SmartNoteLifecycleState["checkStatus"],
        checkFailureCount: row.check_failure_count,
        checkNetworkFailureCount: row.check_network_failure_count,
        checkQuarantinedUntil: row.check_quarantined_until,
        checkNextDueAt: row.check_next_due_at,
        checkCompiledAt: row.check_compiled_at,
        checkFalseSinceAt: row.check_false_since_at,
        checkLastLivenessAt: row.check_last_liveness_at,
        policyVersion: row.policy_version,
    });
}

function toOutcome(goldenCase: GoldenTransitionCase): SmartNoteEvaluationOutcome {
    const { phase, outcome } = goldenCase;
    if (
        phase === "compile" &&
        (outcome.kind === "compiled_met" || outcome.kind === "compiled_false")
    ) {
        return {
            phase,
            kind: outcome.kind,
            artifact: {
                compiledCheck: outcome.compiled_check as string,
                manifestJson: outcome.manifest_json as string,
                checkHash: outcome.check_hash as string,
                checkCron: outcome.check_cron as string,
            },
        };
    }
    return { phase, kind: outcome.kind } as SmartNoteEvaluationOutcome;
}

describe("smart-note evaluation reducer characterization", () => {
    for (const goldenCase of golden.transition_cases) {
        test(`transition ${goldenCase.id}`, () => {
            const reduction = reduceSmartNoteEvaluation(
                toState(goldenCase.pre),
                toOutcome(goldenCase),
                { noteId: goldenCase.note_id, now: goldenCase.now },
            );
            expect(reduction.next).toEqual(toState(goldenCase.expected));
            expect(reduction.surfaced).toBe(goldenCase.expected.status === "ready");
        });
    }
});

describe("dueReadyReason surrogate-boundary parity", () => {
    test("a cap that splits a surrogate pair drops the lone high surrogate", () => {
        // Prefix "Smart note #1: " is 15 units; unit 240 falls inside an
        // emoji pair when the signal is all non-BMP scalars (odd prefix).
        const signal = "\u{1F600}".repeat(200);
        const reason = dueReadyReason(1, JSON.stringify({ signals: [signal] }));
        // The Rust reducer never emits a broken pair; both authorities must
        // persist the identical 239-unit value.
        expect(reason.length).toBe(239);
        const last = reason.charCodeAt(reason.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    });

    test("short reasons pass through untouched", () => {
        expect(dueReadyReason(7, JSON.stringify({ signals: ["build is green"] }))).toBe(
            "Smart note #7: build is green",
        );
    });
});
