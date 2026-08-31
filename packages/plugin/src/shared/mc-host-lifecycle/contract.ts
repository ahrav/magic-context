/**
 * Strict runtime schema for the native `magic-context.daemon/v1` result and
 * the bounded pre-native root classifier (plan U3, KTD12).
 *
 * Every closed union is sourced from the generated release contract, so a
 * regenerated contract is the only way the vocabulary can change. Parsing is
 * fail-closed: any unknown field, out-of-union value, unsorted check list, or
 * exit/result disagreement is a typed `ContractViolation`, never a cast.
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

/** 1-based precedence for failing reasons; lower wins. Non-failing is null. */
export function reasonPrecedence(reason: DaemonReason): number | null {
    return FAILING_REASONS.get(reason)?.precedence ?? null;
}

/**
 * The fixed reason-to-remediation mapping from the release contract.
 * `harness_unavailable` remediation is subreason-driven and returns null
 * here; consumers with a subreason use {@link harnessRemediationFor}.
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
 * Subreason-specific `harness_unavailable` remediation. Unknown subreasons
 * fail closed as a violation rather than mapping to a guessed remediation.
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

/** One validated `magic-context.daemon/v1` result object. */
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

/** Typed fail-closed schema failure. Carries no native text beyond a bounded field name. */
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
    // Each component state admits an explicit reason set rather than a blanket
    // failing/non-failing split. `ready` asserts the component is usable, so a
    // reason naming the failure that stopped it is self-contradictory — but the
    // converse does not hold either: `unsupported` with `synapse_unsupported` is
    // a legitimate non-failing pairing, while every `starting` reason is a
    // failing one, so "non-ready implies failing" would reject conforming
    // output. Only the exact pairings the daemon emits are accepted.
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
        // The ready case gets its own wording: it is the one pairing whose
        // danger is specific — a consumer told the component is serving while
        // the reason names the failure that stopped it.
        if (state === "ready" && !NON_FAILING_REASONS.has(reason)) {
            fail(`readiness.${component} is ready with a failing reason`);
        }
        fail(`readiness.${component} state contradicts its reason`);
    }
    return { state, reason };
}

/**
 * Parse the native binary's stdout into one validated v1 result. The input
 * must be exactly one JSON object (`JSON.parse` rejects trailing bytes) with
 * the exact v1 key set and every value inside its closed union.
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
    requireExactKeys(
        record,
        [
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
        ],
        "result",
    );
    if (record.schema !== DAEMON_RESULT_SCHEMA) fail("schema is not magic-context.daemon/v1");
    const command = record.command;
    // The contract's command union is exactly start/stop/restart/status/doctor.
    // `probe` is an accepted argv spelling of the read-only observation, but the
    // binary answers it as `status`, so a `probe` in a *result* is a
    // nonconforming payload rather than a dialect to tolerate.
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
    // `ok` is the boolean summary of the reason's class, so exactly one of the
    // two pairings is legal: a non-failing reason with `ok:true`, a failing
    // reason with `ok:false`. Validating the two fields independently admits
    // `{ok:true, reason:"internal_error"}`, which agrees with exit 0 and reads
    // as success to every consumer that branches on `ok`.
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
    // Membership in the remediation set is not enough: it admits a valid
    // remediation borrowed from a *different* reason — `native_payload_missing`
    // paired with `free_storage` — which sends an operator to fix storage when
    // the payload is absent. The reason determines the remediation.
    //
    // `harness_unavailable` is the one contract-sanctioned exception: it is
    // declared `remediation_from_subreason`, so `remediationForReason` answers
    // null and the conforming result carries whichever remediation its
    // subreason maps to. Only that reason gets the wider set.
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
        // A restart's `ok` is the successor start's outcome — the native
        // implementation derives `start_committed` from exactly that value — so
        // `ok:true` with no committed start is self-contradictory, and exit 0
        // agrees with it, handing callers a successful restart whose own
        // transaction record says no successor came up.
        //
        // The converse is deliberately allowed: `ok:false` with
        // `start_committed:true` is an honest report that the start committed
        // before something later failed, and rejecting it would suppress
        // evidence of a committed effect, which is the more dangerous error.
        if (record.ok && !effects.start_committed) {
            fail("a successful restart must report a committed start");
        }
        if (record.ok && (state !== "running" || reason !== "started")) {
            fail("a successful restart contradicts its start effect");
        }
    } else if (command === "restart" && record.ok) {
        // Guarding only the non-null branch left the evidence-free case open:
        // `{command:"restart", ok:true, effects:null}` would parse and agree
        // with exit 0, so a caller learned the restart succeeded but not that
        // the stop and successor start committed. Every return path in the
        // native `cmd_restart()` supplies effects, so their absence on a
        // successful restart is skew rather than a reticent implementation.
        //
        // Only successful restarts are required to carry them: a killed
        // transaction's outcome is genuinely unknown, and the policy's local
        // results report `effects:null` precisely to avoid claiming otherwise.
        fail("a successful restart must carry its effects");
    }
    let readiness: DaemonReadiness | null = null;
    if (record.readiness !== null) {
        const rawReadiness = requireObject(record.readiness, "readiness");
        readiness = {};
        for (const [component, value] of Object.entries(rawReadiness)) {
            if (component !== "transport" && component !== "storage" && component !== "synapse") {
                fail("readiness carries an unknown component");
            }
            readiness[component] = parseReadinessRecord(value, component);
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
        // The same coupling the top-level `ok` gets: a check's status is the
        // boolean summary of its reason's class, so a `pass` carrying an
        // explicitly failing reason — or a `fail` carrying a non-failing one —
        // hands diagnostic automation two contradictory answers about the same
        // check, on a result that exit code 0 agrees with.
        //
        // Only `pass` and `fail` are constrained. `warn` and `skip` are not a
        // class summary at all: a warn is a degraded-but-usable observation and
        // a skip is an absence of evidence, and the contract does not fix which
        // reason class either may carry.
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
        // Only `pass` and `fail` are constrained. `warn` and `skip` are not a
        // class summary at all: a warn is a degraded-but-usable observation and
        // a skip is an absence of evidence, and the contract does not fix which
        // reason class either may carry.
        if (status === "pass" && !NON_FAILING_REASONS.has(checkReason)) {
            fail("a passing check carries a failing reason");
        }
        if (status === "fail" && NON_FAILING_REASONS.has(checkReason)) {
            fail("a failing check carries a non-failing reason");
        }
        // Same reason-determines-remediation rule as the top-level result: a
        // per-check remediation borrowed from another reason misdirects the
        // operator just as effectively. `harness_unavailable` is exempt for the
        // same contract reason — its remediation comes from the subreason.
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
 * Exit/result agreement (KTD12): exit 0 means `ok:true` and exit 1 means an
 * operational `ok:false`. Any other pairing is a contract violation the
 * caller must fail closed on.
 */
export function exitAgreesWithResult(exitCode: number, result: DaemonResultV1): boolean {
    if (exitCode === 0) return result.ok;
    if (exitCode === 1) return !result.ok;
    return false;
}

// ---------------------------------------------------------------------------
// Bounded pre-native root classifier (KTD12 / R18).
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
 * Classify the two roots that decide the no-probe verdict: the stable
 * coordination directory and the daemon runtime directory. Only two
 * definitely absent roots classify as `absent` (reportable as `stopped`);
 * a symlink, special file, access error, or a presence flip between the two
 * bounded passes is a hazard, and anything else that exists is residual.
 * The classifier never creates, opens, follows, or mutates anything.
 *
 * Both roots must be daemon-owned. The enclosing `cortexkit` subtree is not:
 * `data-path.ts` puts the application SQLite store at
 * `<dataRoot>/cortexkit/magic-context`, so that directory exists on every
 * install that has ever run the plugin and its presence says nothing about a
 * daemon. Probing it would make `residual`/`wedged` the only reachable
 * verdict in the field.
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

/** The KTD12 no-probe daemon state for a pre-native failure. */
export function preNativeState(classification: PreNativeRootsClassification): DaemonState {
    return classification.kind === "absent" ? "stopped" : "wedged";
}

/**
 * The no-probe verdict for observational commands when no trusted retained
 * current-release bootstrap exists: definitely absent roots are a coherent
 * `stopped`/`not_running`; every residual, hazardous, or racing observation
 * is `wedged`/`native_probe_unavailable` and authorizes no mutation.
 */
export function probeFallbackVerdict(classification: PreNativeRootsClassification): {
    state: DaemonState;
    reason: DaemonReason;
} {
    if (classification.kind === "absent") return { state: "stopped", reason: "not_running" };
    return { state: "wedged", reason: "native_probe_unavailable" };
}
