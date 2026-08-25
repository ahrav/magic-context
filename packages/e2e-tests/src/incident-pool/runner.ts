/**
 * Isolated parent runner (U2, KTD2, KTD3, KTD9, R6, R13).
 *
 * The parent snapshots the catalog, full adjudication ledger, selected set,
 * selected baseline events, and one run nonce; spawns each case in a fresh
 * owner-only workspace and its own process group with an allowlisted
 * environment; and accepts exactly one bounded, schema-versioned envelope on
 * a parent-only result channel (a dedicated fd-3 pipe that product/provider
 * descendants do not inherit). stdout/stderr flow to capped teardown-deleted
 * diagnostic sinks and are NEVER parsed as verdicts.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
    CHECK_ID_RE,
    EXECUTABLE_LANES,
    VARIANT_ID_RE,
    type BaselineVerdict,
    type Harness,
    type IncidentCatalog,
    type Lane,
} from "./contract";
import type { LedgerState } from "./history";
import {
    asEnum,
    asHex64,
    asId,
    asIdArray,
    asRecord,
    asRunNonce,
    fail,
    newRunNonce,
    requireExactKeys,
    type IncidentCaseResult,
    type IncidentPoolReport,
    type ResultLane,
    type ResultReasonCode,
    type RunHealth,
    buildIncidentReport,
    computeSelectedSetDigest,
} from "./report";
import { ledgerFingerprint } from "./registry";
import {
    DiagnosticSink,
    assertLoopbackProviderEndpoints,
    buildCaseEnv,
    createCaseWorkspace,
    destroyCaseWorkspace,
    type CaseWorkspace,
} from "./support/case-workspace";

export const CASE_ENVELOPE_SCHEMA = "incident-case-envelope/v1";
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const DEFAULT_DIAGNOSTIC_CAP_BYTES = 256 * 1024;
export const DEFAULT_CASE_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Child result envelope: one bounded, schema-versioned message per child.
// ---------------------------------------------------------------------------

export interface CaseEnvelope {
    schema: typeof CASE_ENVELOPE_SCHEMA;
    run_nonce: string;
    variant_id: string;
    semantic_fingerprint: string;
    implementation_digest: string;
    ledger_fingerprint: string;
    baseline_event_id: string;
    preconditions: "satisfied" | "failed";
    precondition_reason: "blocked_by_dependency" | "precondition_unmet" | null;
    blocked_by: string[];
    verdict: "pass" | "assertion_fail" | null;
    failed_checks: string[];
    observation_signature: string | null;
}

export function parseCaseEnvelope(raw: unknown): CaseEnvelope {
    const label = "envelope";
    const record = asRecord(raw, label);
    requireExactKeys(
        record,
        [
            "schema",
            "run_nonce",
            "variant_id",
            "semantic_fingerprint",
            "implementation_digest",
            "ledger_fingerprint",
            "baseline_event_id",
            "preconditions",
            "precondition_reason",
            "blocked_by",
            "verdict",
            "failed_checks",
            "observation_signature",
        ],
        label,
    );
    if (record.schema !== CASE_ENVELOPE_SCHEMA)
        fail(`${label}.schema`, `must be ${CASE_ENVELOPE_SCHEMA}`);
    const preconditions = asEnum(
        record.preconditions,
        ["satisfied", "failed"] as const,
        `${label}.preconditions`,
    );
    const blockedBy = asIdArray(
        record.blocked_by,
        VARIANT_ID_RE,
        `${label}.blocked_by`,
    );
    const failedChecks = asIdArray(
        record.failed_checks,
        CHECK_ID_RE,
        `${label}.failed_checks`,
    );
    const verdict =
        record.verdict === null
            ? null
            : asEnum(
                  record.verdict,
                  ["pass", "assertion_fail"] as const,
                  `${label}.verdict`,
              );
    const preconditionReason =
        record.precondition_reason === null
            ? null
            : asEnum(
                  record.precondition_reason,
                  ["blocked_by_dependency", "precondition_unmet"] as const,
                  `${label}.precondition_reason`,
              );
    const observationSignature =
        record.observation_signature === null
            ? null
            : asHex64(
                  record.observation_signature,
                  `${label}.observation_signature`,
              );

    if (preconditions === "failed") {
        if (verdict !== null)
            fail(
                label,
                "failed preconditions must not carry a behavioral verdict",
            );
        if (preconditionReason === null)
            fail(label, "failed preconditions require a static reason code");
        if (failedChecks.length !== 0 || observationSignature !== null) {
            fail(
                label,
                "failed preconditions must not carry checks or signatures",
            );
        }
        if (
            preconditionReason === "blocked_by_dependency" &&
            blockedBy.length === 0
        ) {
            fail(
                label,
                "blocked_by_dependency requires at least one dependency",
            );
        }
        if (
            preconditionReason === "precondition_unmet" &&
            blockedBy.length !== 0
        ) {
            fail(label, "precondition_unmet must not carry dependencies");
        }
    } else {
        if (verdict === null)
            fail(label, "satisfied preconditions require a behavioral verdict");
        if (preconditionReason !== null || blockedBy.length !== 0) {
            fail(
                label,
                "satisfied preconditions must not carry a precondition reason or dependencies",
            );
        }
        if (
            verdict === "pass" &&
            (failedChecks.length !== 0 || observationSignature !== null)
        ) {
            fail(
                label,
                "pass must not carry failed checks or an observation signature",
            );
        }
        if (verdict === "assertion_fail") {
            if (failedChecks.length === 0)
                fail(
                    label,
                    "assertion_fail requires at least one failed check",
                );
            if (observationSignature === null)
                fail(label, "assertion_fail requires an observation signature");
        }
    }

    return {
        schema: CASE_ENVELOPE_SCHEMA,
        run_nonce: asRunNonce(record.run_nonce, `${label}.run_nonce`),
        variant_id: asId(
            record.variant_id,
            VARIANT_ID_RE,
            `${label}.variant_id`,
        ),
        semantic_fingerprint: asHex64(
            record.semantic_fingerprint,
            `${label}.semantic_fingerprint`,
        ),
        implementation_digest: asHex64(
            record.implementation_digest,
            `${label}.implementation_digest`,
        ),
        ledger_fingerprint: asHex64(
            record.ledger_fingerprint,
            `${label}.ledger_fingerprint`,
        ),
        baseline_event_id: asId(
            record.baseline_event_id,
            /^adj-[a-z0-9]+(?:-[a-z0-9]+)*$/,
            `${label}.baseline_event_id`,
        ),
        preconditions,
        precondition_reason: preconditionReason,
        blocked_by: blockedBy,
        verdict,
        failed_checks: failedChecks,
        observation_signature: observationSignature,
    };
}

// ---------------------------------------------------------------------------
// Selection and run snapshot (KTD9).
// ---------------------------------------------------------------------------

export interface SelectedCase {
    familyId: string;
    variantId: string;
    lane: ResultLane;
    semanticRevisionId: string;
    semanticFingerprint: string;
    implementationDigest: string;
    normativeChecks: string[];
    blockedBy: string[];
    baselineEventId: string;
    baselineVerdict: BaselineVerdict;
    expectedFailedChecks: string[];
    expectedObservationSignature: string | null;
}

export interface ExcludedCase {
    variantId: string;
    reason: string;
}

export interface RunSnapshot {
    runNonce: string;
    harness: Harness;
    ledgerFingerprint: string;
    selected: SelectedCase[];
    excluded: ExcludedCase[];
    selectedSetDigest: string;
    familyCount: number;
    variantCount: number;
}

export interface BuildSnapshotInput {
    catalog: IncidentCatalog;
    ledger: LedgerState;
    /** Raw ledger lines; hashed into the full-ledger fingerprint. */
    adjudicationLines: readonly string[];
    harness: Harness;
    lanes: readonly Lane[];
    /** Optional exact variant selection; absent means every matching variant. */
    variantIds?: readonly string[];
    /** variantId -> implementation-bundle digest for every executable case. */
    implementationDigests: ReadonlyMap<string, string>;
}

/**
 * Select the executable variants for one harness/lane request. Inapplicable
 * harnesses stay OUTSIDE the selected set with their documented reason; a
 * selected variant with a missing or stale baseline is a hard error.
 */
export function buildRunSnapshot(input: BuildSnapshotInput): RunSnapshot {
    const selected: SelectedCase[] = [];
    const excluded: ExcludedCase[] = [];
    const requestedVariants = input.variantIds
        ? new Set(input.variantIds)
        : null;
    for (const family of input.catalog.families) {
        for (const variant of family.variants) {
            if (!EXECUTABLE_LANES.includes(variant.lane)) {
                excluded.push({
                    variantId: variant.id,
                    reason: "adjudication-only variants are never scheduled",
                });
                continue;
            }
            if (requestedVariants && !requestedVariants.has(variant.id)) {
                excluded.push({
                    variantId: variant.id,
                    reason: "variant was not requested",
                });
                continue;
            }
            if (!input.lanes.includes(variant.lane)) {
                excluded.push({
                    variantId: variant.id,
                    reason: `lane ${variant.lane} was not requested`,
                });
                continue;
            }
            const applicability = variant.applicability;
            if (applicability === null)
                throw new Error(
                    `executable variant ${variant.id} lacks applicability`,
                );
            if (applicability.harness !== input.harness) {
                const documented = applicability.omitted.find(
                    (omit) => omit.harness === input.harness,
                );
                excluded.push({
                    variantId: variant.id,
                    reason:
                        documented?.reason ??
                        `canonical harness is ${applicability.harness}`,
                });
                continue;
            }
            const history = input.ledger.byIdentity.get(variant.id) ?? null;
            // No later event can reverse a retirement, so a retired variant
            // would otherwise stay scheduled and scored forever.
            if (history?.retired) {
                excluded.push({
                    variantId: variant.id,
                    reason: "variant was retired by adjudication",
                });
                continue;
            }
            const digest = input.implementationDigests.get(variant.id);
            if (digest === undefined) {
                throw new Error(
                    `selected live executable variant ${variant.id} has no registered case digest`,
                );
            }
            const baseline = history?.latestBaseline ?? null;
            if (baseline === null) {
                throw new Error(
                    `selected variant ${variant.id} has no reviewed baseline adjudication`,
                );
            }
            if (
                baseline.semantic_fingerprint !==
                variant.semantic_revision.fingerprint
            ) {
                throw new Error(
                    `selected variant ${variant.id} baseline is stale against its semantic revision`,
                );
            }
            const expectedVerdict: BaselineVerdict =
                variant.lane === "green" ? "green" : "red";
            if (baseline.baseline_verdict !== expectedVerdict) {
                throw new Error(
                    `selected variant ${variant.id} lane disagrees with its baseline verdict`,
                );
            }
            selected.push({
                familyId: family.id,
                variantId: variant.id,
                lane: variant.lane as ResultLane,
                semanticRevisionId: variant.semantic_revision.id,
                semanticFingerprint: variant.semantic_revision.fingerprint,
                implementationDigest: digest,
                normativeChecks: [...variant.normative_checks],
                blockedBy: [...variant.blocked_by],
                baselineEventId: baseline.event_id,
                baselineVerdict: baseline.baseline_verdict as BaselineVerdict,
                expectedFailedChecks: [
                    ...(baseline.expected_failed_checks ?? []),
                ],
                expectedObservationSignature: baseline.observation_signature,
            });
        }
    }
    const digestRows = selected.map(
        (entry) =>
            [
                entry.variantId,
                entry.semanticFingerprint,
                entry.implementationDigest,
                entry.baselineEventId,
            ] as const,
    );
    return {
        runNonce: newRunNonce(),
        harness: input.harness,
        ledgerFingerprint: ledgerFingerprint(input.adjudicationLines),
        selected,
        excluded,
        selectedSetDigest: computeSelectedSetDigest(digestRows),
        familyCount: new Set(selected.map((entry) => entry.familyId)).size,
        variantCount: selected.length,
    };
}

// ---------------------------------------------------------------------------
// Case execution: fresh workspace, own process group, fd-3 result channel.
// ---------------------------------------------------------------------------

export interface RunCaseOptions {
    /** Full argv of the child bootstrap (fake children in tests). */
    argv: string[];
    timeoutMs: number;
    /** Where the fresh case workspace is created. */
    workspaceParentDir: string;
    /** Parent environment the allowlist filters (default process.env). */
    baseEnv?: Record<string, string | undefined>;
    /** Static case-specific configuration merged after the allowlist. */
    extraEnv?: Record<string, string>;
    /** Provider endpoints exported to the child; each MUST be loopback. */
    providerEndpoints?: Record<string, string>;
    diagnosticCapBytes?: number;
}

export interface CaseDiagnosticsSummary {
    stdoutBytes: number;
    stdoutTruncated: boolean;
    stderrBytes: number;
    stderrTruncated: boolean;
    workspaceDeleted: boolean;
}

export interface CaseExecution {
    result: IncidentCaseResult;
    diagnostics: CaseDiagnosticsSummary;
}

interface ProcessOutcome {
    timedOut: boolean;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    envelopeBytes: Buffer;
    envelopeOversized: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** SIGKILL the case's process group, then join: poll until the group is
 *  empty so no descendant can write a late marker or retain a lock. */
async function killAndJoinProcessGroup(pid: number): Promise<void> {
    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // Group already gone.
    }
    const deadline = Date.now() + 2_000;
    for (;;) {
        try {
            process.kill(-pid, 0);
        } catch {
            return; // ESRCH: every group member has terminated.
        }
        if (Date.now() > deadline) {
            throw new Error(
                `process group ${pid} did not terminate after SIGKILL`,
            );
        }
        await sleep(25);
    }
}

function streamDone(stream: Readable | null | undefined): Promise<void> {
    if (!stream || stream.readableEnded || stream.destroyed)
        return Promise.resolve();
    return new Promise((resolveDone) => {
        stream.once("end", resolveDone);
        stream.once("close", resolveDone);
        stream.once("error", resolveDone);
    });
}

function spawnCaseProcess(
    argv: string[],
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    stdoutSink: DiagnosticSink,
    stderrSink: DiagnosticSink,
): Promise<ProcessOutcome> {
    return new Promise((resolveOutcome, rejectOutcome) => {
        const [command, ...args] = argv;
        if (!command) {
            rejectOutcome(new Error("case argv must name a command"));
            return;
        }
        // detached => own process group so termination covers descendants.
        const child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        let envelopeLength = 0;
        let oversized = false;
        let timedOut = false;
        let exitCode: number | null = null;
        let signal: NodeJS.Signals | null = null;
        let settled = false;
        let diagnosticError = false;

        const writeDiagnostic = (sink: DiagnosticSink, chunk: Buffer): void => {
            try {
                sink.write(chunk);
            } catch {
                diagnosticError = true;
                try {
                    if (child.pid !== undefined)
                        process.kill(-child.pid, "SIGKILL");
                } catch {
                    // Child exited before the diagnostic failure could stop it.
                }
            }
        };
        child.stdout?.on("data", (chunk: Buffer) =>
            writeDiagnostic(stdoutSink, chunk),
        );
        child.stderr?.on("data", (chunk: Buffer) =>
            writeDiagnostic(stderrSink, chunk),
        );
        const channel = child.stdio[3] as Readable | null;
        channel?.on("data", (chunk: Buffer) => {
            if (oversized) return;
            if (envelopeLength + chunk.length > MAX_ENVELOPE_BYTES) {
                oversized = true; // stop retaining unbounded child output
                return;
            }
            chunks.push(chunk);
            envelopeLength += chunk.length;
        });

        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (child.pid !== undefined)
                    process.kill(-child.pid, "SIGKILL");
            } catch {
                // Child exited between the deadline and the kill.
            }
        }, timeoutMs);

        const settle = async (): Promise<void> => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.pid !== undefined)
                await killAndJoinProcessGroup(child.pid);
            // Drain buffered pipe data; the group is dead, so this is bounded.
            await Promise.race([
                Promise.all([
                    streamDone(channel),
                    streamDone(child.stdout),
                    streamDone(child.stderr),
                ]),
                sleep(2_000),
            ]);
            if (diagnosticError) {
                rejectOutcome(new Error("diagnostic sink write failed"));
                return;
            }
            resolveOutcome({
                timedOut,
                exitCode,
                signal,
                envelopeBytes: Buffer.concat(chunks),
                envelopeOversized: oversized,
            });
        };

        child.once("exit", (code, exitSignal) => {
            exitCode = code;
            signal = exitSignal;
            void settle().catch(rejectOutcome);
        });
        child.once("error", () => void settle().catch(rejectOutcome));
    });
}

function unhealthyResult(
    selected: SelectedCase,
    runHealth: Exclude<RunHealth, "completed">,
    reasonCode: ResultReasonCode,
): IncidentCaseResult {
    return {
        family_id: selected.familyId,
        variant_id: selected.variantId,
        lane: selected.lane,
        semantic_revision_id: selected.semanticRevisionId,
        semantic_fingerprint: selected.semanticFingerprint,
        implementation_digest: selected.implementationDigest,
        baseline_event_id: selected.baselineEventId,
        baseline_verdict: selected.baselineVerdict,
        run_health: runHealth,
        behavioral_verdict: "not_evaluated",
        baseline_comparison: "unscored",
        failed_checks: [],
        observation_signature: null,
        blocked_by: [],
        reason_code: reasonCode,
    };
}

/** Structurally complete `unavailable` fact for an applicable selected case
 *  whose prerequisite is missing — published, never scored (R6). */
export function unavailableCaseResult(
    selected: SelectedCase,
): IncidentCaseResult {
    return unhealthyResult(selected, "unavailable", "prerequisite_missing");
}

function sameCheckSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const set = new Set(a);
    return b.every((id) => set.has(id));
}

/** Classify one accepted envelope against the run snapshot (KTD8, KTD9). */
function classifyEnvelope(
    snapshot: RunSnapshot,
    selected: SelectedCase,
    envelope: CaseEnvelope,
): IncidentCaseResult {
    if (
        envelope.run_nonce !== snapshot.runNonce ||
        envelope.variant_id !== selected.variantId ||
        envelope.semantic_fingerprint !== selected.semanticFingerprint ||
        envelope.implementation_digest !== selected.implementationDigest ||
        envelope.ledger_fingerprint !== snapshot.ledgerFingerprint ||
        envelope.baseline_event_id !== selected.baselineEventId
    ) {
        return unhealthyResult(selected, "malformed", "snapshot_mismatch");
    }
    const declared = new Set(selected.normativeChecks);
    if (envelope.failed_checks.some((id) => !declared.has(id))) {
        return unhealthyResult(selected, "malformed", "invalid_envelope");
    }

    const base = unhealthyResult(selected, "malformed", "invalid_envelope");
    if (envelope.preconditions === "failed") {
        const reviewed =
            envelope.precondition_reason === "blocked_by_dependency" &&
            selected.blockedBy.length > 0 &&
            sameCheckSet(envelope.blocked_by, selected.blockedBy);
        return {
            ...base,
            run_health: "completed",
            behavioral_verdict: "not_evaluated",
            baseline_comparison: "unscored",
            blocked_by: reviewed ? envelope.blocked_by : [],
            reason_code: reviewed
                ? "blocked_by_dependency"
                : "precondition_unmet",
        };
    }

    const verdict = envelope.verdict as "pass" | "assertion_fail";
    let comparison: IncidentCaseResult["baseline_comparison"];
    if (selected.baselineVerdict === "green") {
        comparison = verdict === "pass" ? "expected_green" : "regression";
    } else if (verdict === "pass") {
        comparison = "resolution_candidate";
    } else {
        const matches =
            sameCheckSet(
                envelope.failed_checks,
                selected.expectedFailedChecks,
            ) &&
            envelope.observation_signature ===
                selected.expectedObservationSignature;
        comparison = matches ? "expected_red" : "unexpected_failure";
    }
    return {
        ...base,
        run_health: "completed",
        behavioral_verdict: verdict,
        baseline_comparison: comparison,
        failed_checks: envelope.failed_checks,
        observation_signature: envelope.observation_signature,
        reason_code: null,
    };
}

function classifyOutcome(
    snapshot: RunSnapshot,
    selected: SelectedCase,
    outcome: ProcessOutcome,
): IncidentCaseResult {
    if (outcome.timedOut)
        return unhealthyResult(selected, "timeout", "deadline_exceeded");
    if (outcome.envelopeOversized)
        return unhealthyResult(selected, "malformed", "envelope_oversized");
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
        return unhealthyResult(selected, "crash", "child_exit_failure");
    }
    const text = outcome.envelopeBytes.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    // A child that exits without an envelope crashed, whatever it printed to
    // stdout — forged stdout success is never parsed as a verdict.
    if (lines.length === 0)
        return unhealthyResult(selected, "crash", "exited_without_envelope");
    if (lines.length > 1)
        return unhealthyResult(selected, "malformed", "duplicate_envelope");
    let envelope: CaseEnvelope;
    try {
        envelope = parseCaseEnvelope(JSON.parse(lines[0]!) as unknown);
    } catch {
        return unhealthyResult(selected, "malformed", "invalid_envelope");
    }
    return classifyEnvelope(snapshot, selected, envelope);
}

function caseIdentityEnv(
    snapshot: RunSnapshot,
    selected: SelectedCase,
    workspace: CaseWorkspace,
): Record<string, string> {
    return {
        MC_INCIDENT_RUN_NONCE: snapshot.runNonce,
        MC_INCIDENT_VARIANT_ID: selected.variantId,
        MC_INCIDENT_SEMANTIC_FINGERPRINT: selected.semanticFingerprint,
        MC_INCIDENT_IMPLEMENTATION_DIGEST: selected.implementationDigest,
        MC_INCIDENT_LEDGER_FINGERPRINT: snapshot.ledgerFingerprint,
        MC_INCIDENT_BASELINE_EVENT_ID: selected.baselineEventId,
        MC_INCIDENT_WORKSPACE_ROOT: workspace.root,
        MC_INCIDENT_STORE_DIR: workspace.store,
        MC_INCIDENT_STORE_NAMESPACE: workspace.storeNamespace,
    };
}

const ISOLATION_ENV_KEYS = new Set([
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
]);

export function assertSafeExtraEnv(extraEnv: Record<string, string>): void {
    for (const key of Object.keys(extraEnv)) {
        const unsafe =
            key.startsWith("MC_INCIDENT_") ||
            key.startsWith("XDG_") ||
            ISOLATION_ENV_KEYS.has(key) ||
            /PROXY/i.test(key) ||
            /^(?:AWS|AZURE|GOOGLE|GCP|OPENAI|ANTHROPIC|COHERE|HUGGINGFACE|SSH)_/i.test(
                key,
            ) ||
            /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|COOKIE|AUTH)/i.test(
                key,
            );
        if (unsafe) {
            throw new Error(`unsafe incident case extraEnv key ${key}`);
        }
    }
}

/**
 * Run one selected case in full isolation and return its terminal result
 * plus a numeric diagnostics summary (counters only — no output bytes). The
 * workspace and every diagnostic sink are deleted before this returns.
 */
export async function runCaseInIsolation(
    snapshot: RunSnapshot,
    selected: SelectedCase,
    options: RunCaseOptions,
): Promise<CaseExecution> {
    if (options.providerEndpoints)
        assertLoopbackProviderEndpoints(options.providerEndpoints);
    if (options.extraEnv) assertSafeExtraEnv(options.extraEnv);
    const workspace = createCaseWorkspace(
        options.workspaceParentDir,
        selected.variantId,
        snapshot.runNonce,
    );
    const cap = options.diagnosticCapBytes ?? DEFAULT_DIAGNOSTIC_CAP_BYTES;
    const stdoutSink = new DiagnosticSink(
        join(workspace.diagnosticsDir, "stdout.log"),
        cap,
    );
    const stderrSink = new DiagnosticSink(
        join(workspace.diagnosticsDir, "stderr.log"),
        cap,
    );
    let outcome: ProcessOutcome;
    try {
        const env = {
            ...buildCaseEnv(workspace, options.baseEnv ?? process.env),
            ...(options.providerEndpoints ?? {}),
            ...(options.extraEnv ?? {}),
            ...caseIdentityEnv(snapshot, selected, workspace),
        };
        outcome = await spawnCaseProcess(
            options.argv,
            workspace.root,
            env,
            options.timeoutMs,
            stdoutSink,
            stderrSink,
        );
    } finally {
        stdoutSink.close();
        stderrSink.close();
        destroyCaseWorkspace(workspace);
    }
    return {
        result: classifyOutcome(snapshot, selected, outcome),
        diagnostics: {
            stdoutBytes: stdoutSink.bytesWritten,
            stdoutTruncated: stdoutSink.truncated,
            stderrBytes: stderrSink.bytesWritten,
            stderrTruncated: stderrSink.truncated,
            workspaceDeleted: !existsSync(workspace.root),
        },
    };
}

/** Execute every selected case (sequentially — cases own real stores and
 *  process groups) and build the structurally complete report. */
export async function runIncidentPool(
    snapshot: RunSnapshot,
    runCase: (selected: SelectedCase) => Promise<IncidentCaseResult>,
): Promise<IncidentPoolReport> {
    const results: IncidentCaseResult[] = [];
    for (const selected of snapshot.selected) {
        try {
            results.push(await runCase(selected));
        } catch {
            results.push(
                unhealthyResult(selected, "crash", "case_execution_failed"),
            );
        }
    }
    return buildIncidentReport({
        runNonce: snapshot.runNonce,
        harness: snapshot.harness,
        ledgerFingerprint: snapshot.ledgerFingerprint,
        selectedSetDigest: snapshot.selectedSetDigest,
        selectedVariantIds: snapshot.selected.map(
            (selected) => selected.variantId,
        ),
        familyCount: snapshot.familyCount,
        results,
    });
}
