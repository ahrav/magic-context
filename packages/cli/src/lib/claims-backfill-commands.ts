import {
    doctorRetryClaimsBackfill,
    getClaimsBackfillStatus,
    listClaimsBackfillFailures,
    recordClaimsBackfillWarningDisposition,
} from "@magic-context/core/features/magic-context/claims-backfill";
import { getPersistedSchemaVersion } from "@magic-context/core/features/magic-context/storage-db";
import {
    doctorRetryV22Backfill,
    runDeferredV22Backfill,
} from "@magic-context/core/features/magic-context/v22-deferred-backfill";
import type { Database } from "@magic-context/core/shared/sqlite";

export interface ClaimsBackfillCommandArgs {
    checkClaimsBackfill?: boolean;
    retryClaimsBackfill?: boolean;
    /** The command waives this failure id with a warning disposition. */
    waiveClaimsBackfillFailure?: string | null;
    /** The waive command requires this operator rationale. */
    waiveRationale?: string | null;
}

export interface ClaimsBackfillCommandHarness {
    name: string;
    openDatabase(readonly?: boolean): Database | null;
    closeDatabase?(): void;
    log: {
        info(message: string): void;
        success(message: string): void;
        warn(message: string): void;
        error(message: string): void;
    };
}

export interface ClaimsBackfillCommandResult {
    handled: boolean;
    exitCode: number;
}

export function hasClaimsBackfillCommand(args: ClaimsBackfillCommandArgs): boolean {
    return (
        args.checkClaimsBackfill === true ||
        args.retryClaimsBackfill === true ||
        args.waiveClaimsBackfillFailure !== undefined
    );
}

const RETRY_COMMAND = "magic-context doctor --retry-claims-backfill";
const WAIVE_COMMAND =
    'magic-context doctor --waive-claims-backfill-failure <id> --rationale "<why>"';

export function renderClaimsBackfillStatus(
    harness: ClaimsBackfillCommandHarness,
    db: Database,
    status: ReturnType<typeof getClaimsBackfillStatus>,
): void {
    if (!status.applicable) {
        harness.log.info(
            "claims backfill status: not applicable (database has not migrated to v83)",
        );
        return;
    }
    harness.log.info(
        `claims backfill status: ${status.state}; mode=${status.mode}; phase=${status.phase}; ` +
            `linked=${status.linkedBoundaryRows}/${status.expectedRowCount}; boundary=${status.boundaryMemoryId}; ` +
            `blocking=${status.blockingFailures}; warnings=${status.warningFailures}; v22=${status.v22Takeover}`,
    );
    if (status.state === "complete" || status.state === "complete-with-warnings") {
        harness.log.info(
            `reconciliation version ${status.reconciliationVersion}; final outbox watermark ${status.finalOutboxWatermark}`,
        );
    }
    for (const problem of status.problems) harness.log.warn(`reconciliation: ${problem}`);
    if (status.state === "blocked" || status.state === "pending") {
        for (const failure of listClaimsBackfillFailures(db, { limit: 10 })) {
            harness.log.warn(
                `failure #${failure.id} [${failure.disposition}] ${failure.phase}/${failure.itemKind} ${failure.itemKey}: ${failure.reasonCode}`,
            );
        }
    }
    if (status.state === "blocked") {
        harness.log.warn(`Repair with: ${RETRY_COMMAND}`);
        harness.log.warn(`Waive a reviewed lineage failure with: ${WAIVE_COMMAND}`);
    } else if (status.state === "complete-with-warnings") {
        harness.log.warn(
            `${status.warningFailures} operator-waived warning(s) retained on the repair surface.`,
        );
    }
}

export async function runClaimsBackfillCommands(
    harness: ClaimsBackfillCommandHarness,
    args: ClaimsBackfillCommandArgs,
): Promise<ClaimsBackfillCommandResult> {
    if (!hasClaimsBackfillCommand(args)) {
        return { handled: false, exitCode: 0 };
    }

    let db: Database | null = null;
    try {
        // Status opens the database read-only; retry and waive mutate the
        // database.
        const readonly = !args.retryClaimsBackfill && args.waiveClaimsBackfillFailure === undefined;
        db = harness.openDatabase(readonly);
        if (!db) {
            harness.log.error(`Could not open the ${harness.name} Magic Context database.`);
            return { handled: true, exitCode: 1 };
        }
        const schemaVersionBefore = getPersistedSchemaVersion(db);

        if (args.checkClaimsBackfill) {
            renderClaimsBackfillStatus(
                harness,
                db,
                getClaimsBackfillStatus(db, { includeProblems: true }),
            );
        }

        if (args.waiveClaimsBackfillFailure !== undefined) {
            const rawFailureId = args.waiveClaimsBackfillFailure ?? "";
            const failureId = /^\d+$/.test(rawFailureId) ? Number(rawFailureId) : 0;
            const rationale = args.waiveRationale?.trim() ?? "";
            if (!Number.isSafeInteger(failureId) || failureId < 1) {
                harness.log.error(
                    "--waive-claims-backfill-failure requires a numeric failure id (see --check-claims-backfill).",
                );
                return { handled: true, exitCode: 1 };
            }
            if (rationale.length === 0) {
                harness.log.error(
                    "--waive-claims-backfill-failure requires --rationale with a non-empty operator rationale.",
                );
                return { handled: true, exitCode: 1 };
            }
            const result = recordClaimsBackfillWarningDisposition(db, failureId, rationale);
            if (!result.updated) {
                harness.log.error(result.error ?? "waive failed");
                return { handled: true, exitCode: 1 };
            }
            harness.log.success(
                `Failure #${failureId} waived as a warning. Run ${RETRY_COMMAND} to re-attempt completion.`,
            );
        }

        if (args.retryClaimsBackfill) {
            const status = getClaimsBackfillStatus(db);
            if (!status.applicable) {
                harness.log.info(
                    "claims backfill retry: not applicable (database has not migrated to v83)",
                );
            } else {
                if (status.v22Takeover === "pending") {
                    await runDeferredV22Backfill(db);
                    await doctorRetryV22Backfill(db);
                }
                const retry = await doctorRetryClaimsBackfill(db);
                harness.log.info(
                    `before: phase=${retry.before.phase}; linked=${retry.before.linkedBoundaryRows}/${retry.before.expectedRowCount}; blocking=${retry.before.blockingFailures}; warnings=${retry.before.warningFailures}`,
                );
                harness.log.info(
                    `after:  phase=${retry.after.phase}; linked=${retry.after.linkedBoundaryRows}/${retry.after.expectedRowCount}; blocking=${retry.after.blockingFailures}; warnings=${retry.after.warningFailures}`,
                );
                if (
                    retry.after.state === "complete" ||
                    retry.after.state === "complete-with-warnings"
                ) {
                    harness.log.success(`claims backfill ${retry.after.state}.`);
                } else if (retry.summary !== null) {
                    harness.log.warn(
                        `claims backfill still ${retry.after.state}: ${retry.summary.problems.join("; ") || "see --check-claims-backfill"}`,
                    );
                    return { handled: true, exitCode: 1 };
                }
            }
        }

        const schemaVersionAfter = getPersistedSchemaVersion(db);
        harness.log.info(`Magic Context schema: v${schemaVersionBefore} → v${schemaVersionAfter}`);
        if (!readonly) {
            harness.log.warn(
                "If OpenCode, Pi, or OMP is running, restart it before creating new sessions so every process reloads the repaired state.",
            );
        }
        return { handled: true, exitCode: 0 };
    } catch (error) {
        harness.log.error(error instanceof Error ? error.message : String(error));
        return { handled: true, exitCode: 1 };
    } finally {
        try {
            harness.closeDatabase?.();
        } catch {
            // Close errors are ignored; doctor output already finished. commentlint: allow(JUDGE)
        }
    }
}
