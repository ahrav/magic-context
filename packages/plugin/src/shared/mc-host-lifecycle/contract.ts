/**
 *
 * Unknown fields, out-of-union values, unsorted check lists, and exit/result disagreements throw `ContractViolation`.
 * Invalid input throws `ContractViolation` instead of being cast.
 */

import { lstatSync } from "node:fs";
import { releaseContract } from "./generated-contract";
import { coordinationDirPath, runtimeDirPath } from "./paths";

export type DaemonCommand = (typeof releaseContract.cli.commands)[number];
export type DaemonState = (typeof releaseContract.cli.states)[number];
export type CheckId = (typeof releaseContract.cli.check_ids)[number];
export type CheckStatus = (typeof releaseContract.cli.check_statuses)[number];
export type Remediation = (typeof releaseContract.cli.remediations)[number];
export type FailingReason =
    (typeof releaseContract.cli.reasons.failing_by_precedence)[number]["id"];
export type NonFailingReason = (typeof releaseContract.cli.reasons.non_failing)[number];
export type DaemonReason = FailingReason | NonFailingReason;
export type TransportReadinessState =
    (typeof releaseContract.cli.readiness_states.transport)[number];
export type StorageReadinessState = (typeof releaseContract.cli.readiness_states.storage)[number];
export type SynapseReadinessState = (typeof releaseContract.cli.readiness_states.synapse)[number];

export const DAEMON_RESULT_SCHEMA = releaseContract.cli.result_schema;

const COMMANDS = new Set<string>(releaseContract.cli.commands);
const STATES = new Set<string>(releaseContract.cli.states);
const CHECK_IDS = new Set<string>(releaseContract.cli.check_ids);
const CHECK_STATUSES = new Set<string>(releaseContract.cli.check_statuses);
const REMEDIATIONS = new Set<string>(releaseContract.cli.remediations);
const FAILING_REASONS = new Map<string, { precedence: number; remediation: string | null }>(
    releaseContract.cli.reasons.failing_by_precedence.map((entry, index) => [
        entry.id,
        { precedence: index + 1, remediation: entry.remediation ?? null },
    ]),
);
const NON_FAILING_REASONS = new Set<string>(releaseContract.cli.reasons.non_failing);
const READINESS_STATES: Record<string, ReadonlySet<string>> = {
    transport: new Set(releaseContract.cli.readiness_states.transport),
    storage: new Set(releaseContract.cli.readiness_states.storage),
    synapse: new Set(releaseContract.cli.readiness_states.synapse),
};

export function isDaemonReason(value: string): value is DaemonReason {
    return FAILING_REASONS.has(value) || NON_FAILING_REASONS.has(value);
}

/** Failing reasons have 1-based precedence; lower values win. Non-failing reasons have null precedence. */
export function reasonPrecedence(reason: DaemonReason): number | null {
    return FAILING_REASONS.get(reason)?.precedence ?? null;
}

/**
 * For `harness_unavailable`, this function returns null because remediation depends on the subreason.
 */
export function remediationForReason(reason: DaemonReason): Remediation | null {
    const entry = FAILING_REASONS.get(reason);
    if (!entry) return null;
    return (entry.remediation as Remediation | null) ?? null;
}

export type HarnessUnavailableReason =
    (typeof releaseContract.harness_unavailable.reasons_by_precedence)[number]["id"];

const HARNESS_REASONS = new Map<string, string | null>(
    releaseContract.harness_unavailable.reasons_by_precedence.map((entry) => [
        entry.id,
        entry.remediation ?? null,
    ]),
);

/**
 * Unknown harness subreasons throw a violation instead of using a guessed remediation.
 */
export function harnessRemediationFor(subreason: string): Remediation | null {
    if (!HARNESS_REASONS.has(subreason)) {
        throw new ContractViolation(`unknown harness_unavailable_reason: ${bounded(subreason)}`);
    }
    return (HARNESS_REASONS.get(subreason) as Remediation | null) ?? null;
}

export interface ReadinessRecord {
    state: string;
    reason: DaemonReason;
}

export interface DaemonReadiness {
    transport?: ReadinessRecord;
    storage?: ReadinessRecord;
    synapse?: ReadinessRecord;
}

export interface DaemonCheck {
    id: CheckId;
    status: CheckStatus;
    reason: DaemonReason;
    remediation: Remediation | null;
}

export interface RestartEffects {
    stop_committed: boolean;
    start_committed: boolean;
}

export interface DaemonVersions {
    release: string | null;
    proof: string | null;
    daemon: string | null;
    magic_context: string | null;
    synapse: string | null;
    broca: string | null;
}

/* */
export interface DaemonResultV1 {
    schema: typeof DAEMON_RESULT_SCHEMA;
    command: DaemonCommand;
    ok: boolean;
    state: DaemonState;
    reason: DaemonReason;
    remediation: Remediation | null;
    effects: RestartEffects | null;
    readiness: DaemonReadiness | null;
    checks: DaemonCheck[];
    versions: DaemonVersions;
}

/* */
export class ContractViolation extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ContractViolation";
    }
}

const MAX_DETAIL_LEN = 80;

function bounded(value: string): string {
    return value.length > MAX_DETAIL_LEN ? `${value.slice(0, MAX_DETAIL_LEN)}…` : value;
}

function fail(detail: string): never {
    throw new ContractViolation(`daemon result rejected: ${detail}`);
}

function requireExactKeys(record: Record<string, unknown>, expected: string[], what: string): void {
    const keys = Object.keys(record).sort();
    const sorted = [...expected].sort();
    if (keys.length !== sorted.length || keys.some((key, i) => key !== sorted[i])) {
        fail(`${what} has an unexpected key set`);
    }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(`${what} is not an object`);
    }
    return value as Record<string, unknown>;
}

function nullableString(value: unknown, what: string): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        fail(`${what} is not a bounded nonempty string or null`);
    }
    return value;
}

function parseReadinessRecord(value: unknown, component: string): ReadinessRecord {
    const record = requireObject(value, `readiness.${component}`);
    requireExactKeys(record, ["state", "reason"], `readiness.${component}`);
    const state = record.state;
    const states = READINESS_STATES[component];
    if (typeof state !== "string" || !states || !states.has(state)) {
        fail(`readiness.${component}.state is outside its closed set`);
    }
    const reason = record.reason;
    if (typeof reason !== "string" || !isDaemonReason(reason)) {
        fail(`readiness.${component}.reason is outside the closed reason union`);
    }
    // Component states admit explicit reason sets instead of a blanket failing/non-failing split.
    // `ready` accepts only non-failing reasons.
    // `unsupported` may pair with `synapse_unsupported` without failing.
    // `starting` accepts only failing reasons.
    // `non-ready` does not imply a failing reason because `unsupported` can be non-failing.
    const allowed = {
        transport: {
            ready: ["healthy"],
            starting: ["starting", "lifecycle_busy"],
            unavailable: ["startup_timeout", "publication_missing", "authentication_failed"],
        },
        storage: {
            ready: ["healthy"],
            starting: ["storage_starting", "starting"],
            unavailable: ["storage_unavailable"],
        },
        synapse: {
            ready: ["healthy"],
            starting: ["synapse_starting", "starting"],
            degraded: ["synapse_degraded"],
            unsupported: ["synapse_unsupported"],
        },
    } as const;
    const componentAllowed = allowed[component as keyof typeof allowed] as
        | Record<string, readonly string[]>
        | undefined;
    if (!componentAllowed?.[state]?.includes(reason)) {
        if (state === "ready" && !NON_FAILING_REASONS.has(reason)) {
            fail(`readiness.${component} is ready with a failing reason`);
        }
        fail(`readiness.${component} state contradicts its reason`);
    }
    return { state, reason };
}

/**
 * The parser validates the native binary's stdout as one v1 result.
 * The input must contain one JSON object; `JSON.parse` rejects trailing non-whitespace input.
 * The result must have the exact v1 key set, and each value must belong to its closed union.
 */
export function parseDaemonResult(stdoutText: string): DaemonResultV1 {
    const trimmed = stdoutText.trim();
    if (trimmed.length === 0) fail("empty output");
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        fail("output is not a single JSON value");
    }
    const record = requireObject(parsed, "result");
    const resultKeys = [
        "schema",
        "command",
        "ok",
        "state",
        "reason",
        "remediation",
        "effects",
        "readiness",
        "checks",
        "versions",
    ];
    if ("shared_memory" in record) resultKeys.push("shared_memory");
    requireExactKeys(record, resultKeys, "result");
    if (record.schema !== DAEMON_RESULT_SCHEMA) fail("schema is not magic-context.daemon/v1");
    if (record.shared_memory !== undefined && record.shared_memory !== null) {
        fail("shared_memory diagnostics are not supported by this release");
    }
    const command = record.command;
    // The binary accepts `probe` in argv but returns `status`.
    // A result containing `probe` is nonconforming because the binary returns `status`.
    if (typeof command !== "string" || !COMMANDS.has(command)) {
        fail("command is outside the closed union");
    }
    if (typeof record.ok !== "boolean") fail("ok is not a boolean");
    const state = record.state;
    if (typeof state !== "string" || !STATES.has(state)) {
        fail("state is outside the closed union");
    }
    const reason = record.reason;
    if (typeof reason !== "string" || !isDaemonReason(reason)) {
        fail("reason is outside the closed union");
    }
    // `ok` equals whether the reason is non-failing.
    if (record.ok !== NON_FAILING_REASONS.has(reason)) {
        fail("ok disagrees with reason class");
    }
    if (state === "unavailable" && reason !== "no_data_dir") {
        fail("unavailable is legal only with no_data_dir");
    }
    const remediation = record.remediation;
    if (
        remediation !== null &&
        (typeof remediation !== "string" || !REMEDIATIONS.has(remediation))
    ) {
        fail("remediation is outside the closed union");
    }
    const expectedOk = NON_FAILING_REASONS.has(reason);
    if (record.ok !== expectedOk) {
        fail("ok contradicts the selected reason");
    }
    // A reason may use only its configured remediation.
    //
    const expectedRemediation = remediationForReason(reason);
    const remediationMatches =
        reason === "harness_unavailable"
            ? remediation === null || remediation === "restart_with_supported_harness"
            : remediation === expectedRemediation;
    if (!remediationMatches) {
        fail("remediation does not match its reason");
    }
    const fixedReasonStates: Partial<Record<DaemonReason, DaemonState>> = {
        healthy: "running",
        started: "running",
        already_running: "running",
        stopped: "stopped",
        already_stopped: "stopped",
        not_running: "stopped",
        no_data_dir: "unavailable",
        starting: "starting",
        stopping: "stopping",
        wedged: "wedged",
        shutdown_timeout: "stopping",
    };
    const expectedState = fixedReasonStates[reason];
    if (expectedState !== undefined && state !== expectedState) {
        fail("state contradicts the selected reason");
    }
    let effects: RestartEffects | null = null;
    if (record.effects !== null) {
        if (command !== "restart") fail("effects are restart-only");
        const rawEffects = requireObject(record.effects, "effects");
        requireExactKeys(rawEffects, ["stop_committed", "start_committed"], "effects");
        if (
            typeof rawEffects.stop_committed !== "boolean" ||
            typeof rawEffects.start_committed !== "boolean"
        ) {
            fail("effects fields are not booleans");
        }
        effects = {
            stop_committed: rawEffects.stop_committed,
            start_committed: rawEffects.start_committed,
        };
        //
        if (record.ok && !effects.start_committed) {
            fail("a successful restart must report a committed start");
        }
        if (record.ok && (state !== "running" || reason !== "started")) {
            fail("a successful restart contradicts its start effect");
        }
    } else if (command === "restart" && record.ok) {
        //
        fail("a successful restart must carry its effects");
    }
    let readiness: DaemonReadiness | null = null;
    if (record.readiness !== null) {
        const rawReadiness = requireObject(record.readiness, "readiness");
        readiness = {};
        for (const [component, value] of Object.entries(rawReadiness)) {
            const normalized = component === "shared_memory" ? "transport" : component;
            if (normalized !== "transport" && normalized !== "storage" && normalized !== "synapse") {
                fail("readiness carries an unknown component");
            }
            if (readiness[normalized] !== undefined) {
                fail("readiness carries duplicate transport components");
            }
            readiness[normalized] = parseReadinessRecord(value, normalized);
        }
    }
    if (!Array.isArray(record.checks) || record.checks.length > CHECK_IDS.size) {
        fail("checks is not a bounded array");
    }
    const checks: DaemonCheck[] = record.checks.map((raw) => {
        const check = requireObject(raw, "check");
        requireExactKeys(check, ["id", "status", "reason", "remediation"], "check");
        const id = check.id;
        if (typeof id !== "string" || !CHECK_IDS.has(id)) {
            fail("check id is outside the closed union");
        }
        const status = check.status;
        if (typeof status !== "string" || !CHECK_STATUSES.has(status)) {
            fail("check status is outside the closed union");
        }
        const checkReason = check.reason;
        if (typeof checkReason !== "string" || !isDaemonReason(checkReason)) {
            fail("check reason is outside the closed union");
        }
        //
        if (status === "pass" && !NON_FAILING_REASONS.has(checkReason)) {
            fail("a passing check carries a failing reason");
        }
        if (status === "fail" && NON_FAILING_REASONS.has(checkReason)) {
            fail("a failing check carries a non-failing reason");
        }
        const checkRemediation = check.remediation;
        if (
            checkRemediation !== null &&
            (typeof checkRemediation !== "string" || !REMEDIATIONS.has(checkRemediation))
        ) {
            fail("check remediation is outside the closed union");
        }
        if (status === "pass" && !NON_FAILING_REASONS.has(checkReason)) {
            fail("a passing check carries a failing reason");
        }
        if (status === "fail" && NON_FAILING_REASONS.has(checkReason)) {
            fail("a failing check carries a non-failing reason");
        }
        const expectedCheckRemediation = remediationForReason(checkReason);
        if (
            checkReason !== "harness_unavailable" &&
            checkRemediation !== expectedCheckRemediation
        ) {
            fail("check remediation contradicts its reason");
        }
        return {
            id: id as CheckId,
            status: status as CheckStatus,
            reason: checkReason as DaemonReason,
            remediation: checkRemediation as Remediation | null,
        };
    });
    for (let i = 1; i < checks.length; i++) {
        const prev = checks[i - 1] as DaemonCheck;
        const current = checks[i] as DaemonCheck;
        if (prev.id >= current.id) fail("checks are not lexicographically sorted unique ids");
    }
    if (record.ok && checks.some((check) => check.status === "fail")) {
        fail("successful result contains a failed check");
    }
    const rawVersions = requireObject(record.versions, "versions");
    requireExactKeys(
        rawVersions,
        ["release", "proof", "daemon", "magic_context", "synapse", "broca"],
        "versions",
    );
    const versions: DaemonVersions = {
        release: nullableString(rawVersions.release, "versions.release"),
        proof: nullableString(rawVersions.proof, "versions.proof"),
        daemon: nullableString(rawVersions.daemon, "versions.daemon"),
        magic_context: nullableString(rawVersions.magic_context, "versions.magic_context"),
        synapse: nullableString(rawVersions.synapse, "versions.synapse"),
        broca: nullableString(rawVersions.broca, "versions.broca"),
    };
    return {
        schema: DAEMON_RESULT_SCHEMA,
        command: command as DaemonCommand,
        ok: record.ok,
        state: state as DaemonState,
        reason: reason as DaemonReason,
        remediation: (remediation as Remediation | null) ?? null,
        effects,
        readiness,
        checks,
        versions,
    };
}

/**
 */
export function exitAgreesWithResult(exitCode: number, result: DaemonResultV1): boolean {
    if (exitCode === 0) return result.ok;
    if (exitCode === 1) return !result.ok;
    return false;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export type PreNativeRootsClassification =
    | { kind: "absent" }
    | { kind: "residual" }
    | { kind: "hazard"; hazard: "symlink" | "special" | "access_error" | "race" };

type ProbeOutcome = "absent" | "directory" | "symlink" | "special" | "access_error";

function probeEntry(entryPath: string): ProbeOutcome {
    try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) return "symlink";
        if (stat.isDirectory()) return "directory";
        return "special";
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return "absent";
        return "access_error";
    }
}

/**
 *
 */
export function classifyPreNativeRoots(dataRoot: string): PreNativeRootsClassification {
    const entries = [coordinationDirPath(dataRoot), runtimeDirPath(dataRoot)];
    const first = entries.map(probeEntry);
    const second = entries.map(probeEntry);
    for (let i = 0; i < entries.length; i++) {
        if (first[i] !== second[i]) return { kind: "hazard", hazard: "race" };
    }
    for (const outcome of second) {
        if (outcome === "symlink") return { kind: "hazard", hazard: "symlink" };
        if (outcome === "special") return { kind: "hazard", hazard: "special" };
        if (outcome === "access_error") return { kind: "hazard", hazard: "access_error" };
    }
    if (second.every((outcome) => outcome === "absent")) return { kind: "absent" };
    return { kind: "residual" };
}

/* */
export function preNativeState(classification: PreNativeRootsClassification): DaemonState {
    return classification.kind === "absent" ? "stopped" : "wedged";
}

/**
 */
export function probeFallbackVerdict(classification: PreNativeRootsClassification): {
    state: DaemonState;
    reason: DaemonReason;
} {
    if (classification.kind === "absent") return { state: "stopped", reason: "not_running" };
    return { state: "wedged", reason: "native_probe_unavailable" };
}
