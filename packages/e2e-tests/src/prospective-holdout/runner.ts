import { canonicalFingerprint, canonicalJson } from "../../../plugin/scripts/retrieval-benchmark/canonical-json";
import {
    type FrozenReleaseIdentity,
    HoldoutContractError,
    array,
    enumeration,
    exact,
    fail,
    hex64,
    integer,
    record,
    staticId,
    string,
} from "./contract";
import { assertDistinctReleaseRoots, verifyReleaseRoot, type VerifiedReleaseRoot } from "./release-root";
import type { JsonValue, ProspectiveScenario } from "./registry";
import type { ReleaseRole } from "./blinding";

export const PROSPECTIVE_CELL_SCHEMA = "prospective-cell-result/v1";
export type CellHealth = "completed" | "timeout" | "crash" | "malformed" | "unavailable";
export type ProductOutcome = "pass" | "fail" | "not-evaluated";
export type CellReason =
    | "deadline-exceeded"
    | "runner-crash"
    | "invalid-result"
    | "prerequisite-unavailable"
    | "product-crash";

export interface ProspectiveCellResult {
    schema: typeof PROSPECTIVE_CELL_SCHEMA;
    caseId: string;
    familyId: string;
    releaseRole: ReleaseRole;
    expectedReleaseId: string;
    observedReleaseId: string;
    expectedRootFingerprint: string;
    observedRootFingerprint: string;
    releaseRootManifestFingerprint: string;
    releaseIdentityFingerprint: string;
    implementationFingerprint: string;
    harness: "opencode" | "pi" | "rust";
    model: string;
    seed: number;
    platform: string;
    runHealth: CellHealth;
    productOutcome: ProductOutcome;
    failedChecks: string[];
    reasonCode: CellReason | null;
}

export class ProspectiveProductFailure extends Error {}
export class ProspectivePrerequisiteUnavailable extends Error {}

function terminal(
    scenario: ProspectiveScenario,
    role: ReleaseRole,
    root: VerifiedReleaseRoot,
    expectedRelease: FrozenReleaseIdentity,
    coordinate: Pick<ProspectiveCellResult, "model" | "seed" | "platform">,
    fields: Pick<ProspectiveCellResult, "runHealth" | "productOutcome" | "failedChecks" | "reasonCode">,
): ProspectiveCellResult {
    return {
        schema: PROSPECTIVE_CELL_SCHEMA,
        caseId: scenario.caseId,
        familyId: scenario.familyId,
        releaseRole: role,
        expectedReleaseId: expectedRelease.releaseId,
        observedReleaseId: root.manifest.releaseId,
        expectedRootFingerprint: root.observedRootFingerprint,
        observedRootFingerprint: root.manifest.rootFingerprint,
        releaseRootManifestFingerprint: canonicalFingerprint(root.manifest),
        releaseIdentityFingerprint: canonicalFingerprint(expectedRelease),
        implementationFingerprint: scenario.implementationFingerprint,
        harness: scenario.harness,
        ...coordinate,
        ...fields,
    };
}

/**
 * `UNSETTLED` cannot collide with driver or cleanup results because neither is a string.
 */
const UNSETTLED = "unsettled";

/**
 * `finally` clears the timer after the race settles, preventing it from surviving the wait.
 */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | typeof UNSETTLED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<typeof UNSETTLED>((resolve) => {
                timer = setTimeout(() => resolve(UNSETTLED), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function runProspectiveCase(input: {
    scenario: ProspectiveScenario;
    releaseRole: ReleaseRole;
    releaseRoot: VerifiedReleaseRoot;
    pairedReleaseRoot: VerifiedReleaseRoot;
    expectedRelease: FrozenReleaseIdentity;
    activeCheckout: string;
    workspaceRoot: string;
    model: string;
    seed: number;
    platform: string;
    timeoutMs: number;
}): Promise<ProspectiveCellResult> {
    const root = verifyReleaseRoot(input.releaseRoot.root, input.releaseRoot.manifest, {
        expectedRootFingerprint: input.releaseRoot.observedRootFingerprint,
        activeCheckout: input.activeCheckout,
    });
    const pairedRoot = verifyReleaseRoot(input.pairedReleaseRoot.root, input.pairedReleaseRoot.manifest, {
        expectedRootFingerprint: input.pairedReleaseRoot.observedRootFingerprint,
        activeCheckout: input.activeCheckout,
    });
    assertDistinctReleaseRoots(root, pairedRoot);
    const expected = input.expectedRelease;
    if (
        input.releaseRole !== expected.role ||
        root.manifest.releaseId !== expected.releaseId ||
        root.manifest.channel !== expected.channel ||
        !expected.platformMatrix.includes(root.manifest.platform) ||
        root.manifest.immutableReference !== expected.immutableReference ||
        canonicalFingerprint(root.manifest) !== expected.releaseRootManifestFingerprint ||
        root.manifest.sourceFingerprint !== expected.sourceFingerprint ||
        root.manifest.lockfileFingerprint !== expected.lockfileFingerprint ||
        root.manifest.artifactFingerprint !== expected.artifactFingerprint ||
        root.manifest.runtimeFingerprint !== expected.runtimeFingerprint ||
        root.manifest.harnessFingerprint !== expected.harnessFingerprint
    ) {
        throw new HoldoutContractError(["prospective-runner: release-identity-mismatch"]);
    }
    if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.model) ||
        !Number.isSafeInteger(input.seed) || input.seed < 0 ||
        input.platform !== root.manifest.platform || input.platform !== pairedRoot.manifest.platform
    ) {
        throw new HoldoutContractError(["prospective-runner: execution-coordinate-invalid"]);
    }
    // `input.platform` must match the running host so recorded platform coverage names the platform that ran the driver.
    // A platform that matches both release manifests but not the running host fails with `platform-not-host`.
    if (input.platform !== `${process.platform}-${process.arch}`) {
        throw new HoldoutContractError(["prospective-runner: platform-not-host"]);
    }
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
        throw new HoldoutContractError(["prospective-runner: timeout-invalid"]);
    }
    const coordinate = { model: input.model, seed: input.seed, platform: input.platform };
    const controller = new AbortController();
    const context = {
        workspaceRoot: input.workspaceRoot,
        releaseRoot: root.root,
        ...coordinate,
        signal: controller.signal,
    };
    let cleaned = false;
    const cleanup = async (): Promise<boolean> => {
        if (cleaned) return true;
        cleaned = true;
        try {
            await input.scenario.cleanup(context);
            return true;
        } catch {
            return false;
        }
    };
    /**
     * never settles.
     *
     * The `timeoutMs` cleanup bound prevents a non-settling cleanup from blocking the run.
     *
     * `UNSETTLED` cleanup stops the run because a retry could observe writes from the still-running cleanup; a thrown cleanup is finished and emits a crash cell.
     */
    const settleCleanup = async (): Promise<boolean> => {
        const settled = await bounded(cleanup(), input.timeoutMs);
        if (settled === UNSETTLED) {
            throw new HoldoutContractError(["prospective-runner: cleanup-abandoned"]);
        }
        return settled;
    };
    const finish = async (
        fields: Pick<ProspectiveCellResult, "runHealth" | "productOutcome" | "failedChecks" | "reasonCode">,
    ): Promise<ProspectiveCellResult> => {
        if (!await settleCleanup()) {
            return terminal(input.scenario, input.releaseRole, root, expected, coordinate, {
                runHealth: "crash",
                productOutcome: "not-evaluated",
                failedChecks: [],
                reasonCode: "runner-crash",
            });
        }
        return terminal(input.scenario, input.releaseRole, root, expected, coordinate, fields);
    };
    const execution = Promise.resolve()
        .then(() => input.scenario.driver(context))
        .then((raw) => ({ status: "ok" as const, raw }))
        .catch((error: unknown) => ({ status: "error" as const, error }));
    const raced = await bounded(execution, input.timeoutMs);
    if (raced === UNSETTLED) {
        controller.abort();
        // `cleanup` uses the same `timeoutMs` bound as the driver because it can also fail to settle.
        const settledCleanup = await bounded(cleanup(), input.timeoutMs);
        // `bounded` limits the wait for an abort-ignoring driver or non-terminating cleanup to `timeoutMs`.
        // The drain timeout prevents a non-aborting driver from hanging the run.
        const drained = await bounded(execution, input.timeoutMs);
        // The runner aborts when the driver remains unsettled after the drain because the driver may still modify the workspace.
        // The runner aborts when the driver remains unsettled after the drain because the driver may still modify the workspace.
        // `drained` is checked first because a driver that outlives the deadline is more specific than cleanup waiting on that driver.
        if (drained === UNSETTLED) {
            throw new HoldoutContractError(["prospective-runner: driver-abandoned"]);
        }
        // The runner treats an unsettled cleanup as abandoned because the cleanup may still modify the workspace.
        // The runner treats an unsettled cleanup as abandoned because the cleanup may still modify the workspace.
        if (settledCleanup === UNSETTLED) {
            throw new HoldoutContractError(["prospective-runner: cleanup-abandoned"]);
        }
        return terminal(input.scenario, input.releaseRole, root, expected, coordinate, settledCleanup ? {
            runHealth: "timeout",
            productOutcome: "not-evaluated",
            failedChecks: [],
            reasonCode: "deadline-exceeded",
        } : {
            runHealth: "crash",
            productOutcome: "not-evaluated",
            failedChecks: [],
            reasonCode: "runner-crash",
        });
    }
    if (raced.status === "error") {
        if (raced.error instanceof ProspectiveProductFailure) {
            return finish({
                runHealth: "completed",
                productOutcome: "fail",
                failedChecks: [],
                reasonCode: "product-crash",
            });
        }
        if (raced.error instanceof ProspectivePrerequisiteUnavailable) {
            return finish({
                runHealth: "unavailable",
                productOutcome: "not-evaluated",
                failedChecks: [],
                reasonCode: "prerequisite-unavailable",
            });
        }
        return finish({
            runHealth: "crash",
            productOutcome: "not-evaluated",
            failedChecks: [],
            reasonCode: "runner-crash",
        });
    }
    let produced: unknown;
    try {
        canonicalJson(raced.raw as JsonValue);
        produced = input.scenario.verifier(input.scenario.normalizer(raced.raw));
    } catch {
        return finish({
            runHealth: "completed",
            productOutcome: "fail",
            failedChecks: [],
            reasonCode: "invalid-result",
        });
    }
    // The verifier can return arbitrary values, so validate its result as an array before reading members.
    // The verifier can return arbitrary values, so validate its result as an array before reading members.
    if (
        !Array.isArray(produced) ||
        produced.length === 0 ||
        produced.some((check) => typeof check !== "object" || check === null)
    ) {
        return finish({
            runHealth: "completed",
            productOutcome: "fail",
            failedChecks: [],
            reasonCode: "invalid-result",
        });
    }
    const checks = produced as ReturnType<ProspectiveScenario["verifier"]>;
    // `passed` can be non-boolean at runtime, so validate its type before deriving an outcome.
    // A truthy non-boolean `passed` value, such as `"false"`, would be treated as a pass unless validated as a boolean.
    if (
        checks.some((check) => typeof check.id !== "string") ||
        new Set(checks.map((check) => check.id)).size !== checks.length ||
        checks.some((check) => !/^check-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check.id)) ||
        checks.some((check) => typeof check.passed !== "boolean")
    ) {
        return finish({
            runHealth: "completed",
            productOutcome: "fail",
            failedChecks: [],
            reasonCode: "invalid-result",
        });
    }
    const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id).sort();
    return finish({
        runHealth: "completed",
        productOutcome: failedChecks.length === 0 ? "pass" : "fail",
        failedChecks,
        reasonCode: null,
    });
}

/**
 * `outcomes.json` validation rejects terminal triples that no `runProspectiveCase` path emits.
 * `outcomes.json` validation rejects terminal triples that no `runProspectiveCase` path emits.
 * self-contradictory evidence.
 */
const ALLOWED_CELL_TERMINALS: ReadonlySet<string> = new Set([
    "completed|pass|null",
    "completed|fail|null",
    "completed|fail|product-crash",
    "completed|fail|invalid-result",
    "timeout|not-evaluated|deadline-exceeded",
    "crash|not-evaluated|runner-crash",
    "unavailable|not-evaluated|prerequisite-unavailable",
]);

export function parseProspectiveCellResult(raw: unknown): ProspectiveCellResult {
    const value = record(raw, "cell");
    exact(value, [
        "schema", "caseId", "familyId", "releaseRole", "expectedReleaseId", "observedReleaseId",
        "expectedRootFingerprint", "observedRootFingerprint", "releaseRootManifestFingerprint", "releaseIdentityFingerprint",
        "implementationFingerprint", "harness", "model", "seed", "platform",
        "runHealth", "productOutcome", "failedChecks", "reasonCode",
    ], "cell");
    if (value.schema !== PROSPECTIVE_CELL_SCHEMA) fail("cell.schema: version-invalid");
    const result: ProspectiveCellResult = {
        schema: PROSPECTIVE_CELL_SCHEMA,
        caseId: staticId(value.caseId, "cell.caseId", /^case-[0-9a-f]{32}$/),
        familyId: staticId(value.familyId, "cell.familyId", /^fam-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        releaseRole: enumeration(value.releaseRole, ["release-n", "release-n-minus-1"] as const, "cell.releaseRole"),
        expectedReleaseId: string(value.expectedReleaseId, "cell.expectedReleaseId"),
        observedReleaseId: string(value.observedReleaseId, "cell.observedReleaseId"),
        expectedRootFingerprint: hex64(value.expectedRootFingerprint, "cell.expectedRootFingerprint"),
        observedRootFingerprint: hex64(value.observedRootFingerprint, "cell.observedRootFingerprint"),
        releaseRootManifestFingerprint: hex64(value.releaseRootManifestFingerprint, "cell.releaseRootManifestFingerprint"),
        releaseIdentityFingerprint: hex64(value.releaseIdentityFingerprint, "cell.releaseIdentityFingerprint"),
        implementationFingerprint: hex64(value.implementationFingerprint, "cell.implementationFingerprint"),
        harness: enumeration(value.harness, ["opencode", "pi", "rust"] as const, "cell.harness"),
        model: staticId(value.model, "cell.model", /^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
        seed: integer(value.seed, "cell.seed"),
        platform: staticId(value.platform, "cell.platform"),
        runHealth: enumeration(value.runHealth, ["completed", "timeout", "crash", "malformed", "unavailable"] as const, "cell.runHealth"),
        productOutcome: enumeration(value.productOutcome, ["pass", "fail", "not-evaluated"] as const, "cell.productOutcome"),
        failedChecks: array(value.failedChecks, "cell.failedChecks").map((entry, index) =>
            staticId(entry, `cell.failedChecks[${index}]`, /^check-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        ),
        reasonCode: value.reasonCode === null
            ? null
            : enumeration(value.reasonCode, ["deadline-exceeded", "runner-crash", "invalid-result", "prerequisite-unavailable", "product-crash"] as const, "cell.reasonCode"),
    };
    if (new Set(result.failedChecks).size !== result.failedChecks.length) {
        fail("cell.failedChecks: duplicate");
    }
    if (result.expectedReleaseId !== result.observedReleaseId || result.expectedRootFingerprint !== result.observedRootFingerprint) {
        fail("cell: observed-identity-mismatch");
    }
    if (result.runHealth === "completed") {
        if (result.productOutcome === "not-evaluated") fail("cell: completed-not-evaluated");
        if (result.productOutcome === "pass" && (result.failedChecks.length > 0 || result.reasonCode !== null)) {
            fail("cell: pass-fields-invalid");
        }
        if (result.productOutcome === "fail" && result.failedChecks.length === 0 && !["product-crash", "invalid-result"].includes(result.reasonCode ?? "")) {
            fail("cell: failure-evidence-missing");
        }
    } else if (result.productOutcome !== "not-evaluated" || result.failedChecks.length > 0 || result.reasonCode === null) {
        fail("cell: incomplete-fields-invalid");
    }
    if (!ALLOWED_CELL_TERMINALS.has(`${result.runHealth}|${result.productOutcome}|${result.reasonCode ?? "null"}`)) {
        fail("cell: health-reason-mismatch");
    }
    // The parser requires an empty `failedChecks` array when `reasonCode` identifies a path that bypasses per-check evaluation.
    // The parser requires an empty `failedChecks` array when `reasonCode` identifies a path that bypasses per-check evaluation.
    // never recorded.
    if (result.reasonCode !== null && result.failedChecks.length > 0) {
        fail("cell: reason-code-checks-invalid");
    }
    return result;
}
