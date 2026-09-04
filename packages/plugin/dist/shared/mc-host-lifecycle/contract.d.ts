/**
 * Strict runtime schema for the native `magic-context.daemon/v1` result and
 * the bounded pre-native root classifier (plan U3, KTD12).
 *
 * Every closed union is sourced from the generated release contract, so a
 * regenerated contract is the only way the vocabulary can change. Parsing is
 * fail-closed: any unknown field, out-of-union value, unsorted check list, or
 * exit/result disagreement is a typed `ContractViolation`, never a cast.
 */
import { releaseContract } from "./generated-contract";
export type DaemonCommand = (typeof releaseContract.cli.commands)[number];
export type DaemonState = (typeof releaseContract.cli.states)[number];
export type CheckId = (typeof releaseContract.cli.check_ids)[number];
export type CheckStatus = (typeof releaseContract.cli.check_statuses)[number];
export type Remediation = (typeof releaseContract.cli.remediations)[number];
export type FailingReason = (typeof releaseContract.cli.reasons.failing_by_precedence)[number]["id"];
export type NonFailingReason = (typeof releaseContract.cli.reasons.non_failing)[number];
export type DaemonReason = FailingReason | NonFailingReason;
export type TransportReadinessState = (typeof releaseContract.cli.readiness_states.transport)[number];
export type StorageReadinessState = (typeof releaseContract.cli.readiness_states.storage)[number];
export type SynapseReadinessState = (typeof releaseContract.cli.readiness_states.synapse)[number];
export declare const DAEMON_RESULT_SCHEMA: "magic-context.daemon/v1";
export declare function isDaemonReason(value: string): value is DaemonReason;
/** 1-based precedence for failing reasons; lower wins. Non-failing is null. */
export declare function reasonPrecedence(reason: DaemonReason): number | null;
/**
 * The fixed reason-to-remediation mapping from the release contract.
 * `harness_unavailable` remediation is subreason-driven and returns null
 * here; consumers with a subreason use {@link harnessRemediationFor}.
 */
export declare function remediationForReason(reason: DaemonReason): Remediation | null;
export type HarnessUnavailableReason = (typeof releaseContract.harness_unavailable.reasons_by_precedence)[number]["id"];
/**
 * Subreason-specific `harness_unavailable` remediation. Unknown subreasons
 * fail closed as a violation rather than mapping to a guessed remediation.
 */
export declare function harnessRemediationFor(subreason: string): Remediation | null;
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
export declare class ContractViolation extends Error {
    constructor(message: string);
}
/**
 * Parse the native binary's stdout into one validated v1 result. The input
 * must be exactly one JSON object (`JSON.parse` rejects trailing bytes) with
 * the exact v1 key set and every value inside its closed union.
 */
export declare function parseDaemonResult(stdoutText: string): DaemonResultV1;
/**
 * Exit/result agreement (KTD12): exit 0 means `ok:true` and exit 1 means an
 * operational `ok:false`. Any other pairing is a contract violation the
 * caller must fail closed on.
 */
export declare function exitAgreesWithResult(exitCode: number, result: DaemonResultV1): boolean;
export type PreNativeRootsClassification = {
    kind: "absent";
} | {
    kind: "residual";
} | {
    kind: "hazard";
    hazard: "symlink" | "special" | "access_error" | "race";
};
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
export declare function classifyPreNativeRoots(dataRoot: string): PreNativeRootsClassification;
/** The KTD12 no-probe daemon state for a pre-native failure. */
export declare function preNativeState(classification: PreNativeRootsClassification): DaemonState;
/**
 * The no-probe verdict for observational commands when no trusted retained
 * current-release bootstrap exists: definitely absent roots are a coherent
 * `stopped`/`not_running`; every residual, hazardous, or racing observation
 * is `wedged`/`native_probe_unavailable` and authorizes no mutation.
 */
export declare function probeFallbackVerdict(classification: PreNativeRootsClassification): {
    state: DaemonState;
    reason: DaemonReason;
};
//# sourceMappingURL=contract.d.ts.map