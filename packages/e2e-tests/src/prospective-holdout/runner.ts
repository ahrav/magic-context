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
 * Marks a wait whose bound elapsed before the work settled. Neither a driver
 * result nor a cleanup outcome is a string, so the sentinel cannot collide with a
 * value a bounded wait carries.
 */
const UNSETTLED = "unsettled";

/**
 * Awaits `work` for at most `ms`, reporting `UNSETTLED` once the bound elapses.
 * The timer is cleared in a `finally`, so a bound never outlives the wait it
 * guards, whether that wait yields a value, reports the bound, or throws.
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
    // The agreement above only proves the three declared platforms match each other. A worker
    // handed roots and a coordinate that all name a foreign platform satisfies it, and the cell it
    // records counts as frozen coverage of that platform while the driver ran here. Comparing the
    // coordinate against the running host keeps the recorded platform the one that executed the
    // driver. The code is separate from `execution-coordinate-invalid` because the coordinate is
    // well formed: it names a host this worker is not, so it is rerouted to a matching worker
    // rather than repaired.
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
     * Waits for `cleanup` under the execution deadline, reporting the breach when it
     * never settles.
     *
     * Cleanup is scenario code on every path, not only after an execution timeout, so
     * an unbounded wait wedges the whole cohort until the outer CI timeout whenever a
     * driver that returned normally leaves a cleanup that never settles. `timeoutMs` is
     * the only budget the caller declared, so it bounds this wait too.
     *
     * An unsettled cleanup is not the same evidence as a throwing one. A throwing
     * cleanup has finished: the workspace is unproven but static, which a crash cell
     * describes. An unsettled cleanup is still running and can keep writing the
     * workspace, and the cell it would produce leaves the pair short of "completed",
     * which `buildPairedFacts` accepts as grounds for another attempt. That attempt
     * would observe the abandoned cleanup's writes as its own, so isolation is
     * unprovable and the breach stops the run instead of emitting a cell a retry could
     * build on. This is the rule `driver-abandoned` already applies to a driver that
     * survives its drain.
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
        // Cleanup is scenario code, so it can hang exactly the way a driver can. An unbounded
        // wait here outlives timeoutMs before the drain below bounds anything, which is the
        // hang the deadline exists to prevent, so this wait carries the same bound.
        const settledCleanup = await bounded(cleanup(), input.timeoutMs);
        // A driver that ignores the abort signal, and that cleanup cannot terminate, would
        // otherwise make this await outlive timeoutMs entirely and hang the suite until the
        // CI job timeout. Draining is best effort and bounded by another timeoutMs.
        const drained = await bounded(execution, input.timeoutMs);
        // The bound above trades a hang for a driver that may still hold child processes and
        // still write the workspace. A returned timeout cell leaves the pair short of
        // "completed", which `buildPairedFacts` accepts as grounds for another attempt, so
        // that attempt would run against the abandoned driver's writes and observe them as its
        // own. Isolation is unprovable once the driver survives the drain, so the breach stops
        // the run instead of emitting a cell any retry could build on. The driver is reported
        // first because it is the more specific breach: its own code outlived the deadline,
        // whereas an unsettled cleanup may be waiting on that same driver.
        if (drained === UNSETTLED) {
            throw new HoldoutContractError(["prospective-runner: driver-abandoned"]);
        }
        // A cleanup that never settled is still live and can keep writing the workspace, so
        // it carries the same unprovable isolation as an abandoned driver and stops the run
        // for the same reason. Only a settled cleanup distinguishes the timeout terminal from
        // the crash terminal: it either restored the workspace or threw and left it unproven
        // but static, and no committed row carries a third outcome.
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
    // A verifier is scenario code and its return value reaches here unvalidated, so the
    // declared array type is no evidence about the container either. `null`, a non-array
    // object, or an array holding a non-object would throw on `.length`, `.map`, or a
    // member read, and that throw lands outside the `try` above: it rejects
    // `runProspectiveCase` and can stop the whole cohort instead of producing the
    // `invalid-result` cell malformed verifier output is supposed to produce. The
    // container is proved before any member is read.
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
    // With the container proved, the declared `boolean` is still no evidence about
    // `passed`. A truthy non-boolean such as the string "false" satisfies the failure
    // filter below and would record a pass, so the gate proves the type before any
    // outcome is derived from it.
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
 * Terminal `(runHealth, productOutcome, reasonCode)` triples that
 * `runProspectiveCase` returns, joined by `|` with an absent reason spelled
 * `null`. Committed `outcomes.json` rows are hand-authorable, so the parser
 * refuses triples no runner path emits instead of trusting a row's provenance;
 * otherwise a tampered cell reaches missingness and scorecard adapters as
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
    // Refines an otherwise-permitted terminal: a reason code names a path the runner reaches
    // before, or instead of, per-check evaluation, and every such call site emits an empty
    // list. A row carrying both would let check-counting consumers weigh failures the run
    // never recorded.
    if (result.reasonCode !== null && result.failedChecks.length > 0) {
        fail("cell: reason-code-checks-invalid");
    }
    return result;
}
