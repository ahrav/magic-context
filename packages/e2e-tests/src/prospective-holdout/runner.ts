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
    const finish = async (
        fields: Pick<ProspectiveCellResult, "runHealth" | "productOutcome" | "failedChecks" | "reasonCode">,
    ): Promise<ProspectiveCellResult> => {
        if (!await cleanup()) {
            return terminal(input.scenario, input.releaseRole, root, expected, coordinate, {
                runHealth: "crash",
                productOutcome: "not-evaluated",
                failedChecks: [],
                reasonCode: "runner-crash",
            });
        }
        return terminal(input.scenario, input.releaseRole, root, expected, coordinate, fields);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), input.timeoutMs);
    });
    const execution = Promise.resolve()
        .then(() => input.scenario.driver(context))
        .then((raw) => ({ status: "ok" as const, raw }))
        .catch((error: unknown) => ({ status: "error" as const, error }));
    try {
        const raced = await Promise.race([execution, timeout]);
        if (raced === "timeout") {
            controller.abort();
            const cleanupSucceeded = await cleanup();
            await execution;
            return terminal(input.scenario, input.releaseRole, root, expected, coordinate, cleanupSucceeded ? {
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
        let checks: ReturnType<ProspectiveScenario["verifier"]>;
        try {
            canonicalJson(raced.raw as JsonValue);
            checks = input.scenario.verifier(input.scenario.normalizer(raced.raw));
        } catch {
            return finish({
                runHealth: "completed",
                productOutcome: "fail",
                failedChecks: [],
                reasonCode: "invalid-result",
            });
        }
        const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id).sort();
        if (
            checks.length === 0 ||
            new Set(checks.map((check) => check.id)).size !== checks.length ||
            checks.some((check) => !/^check-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(check.id))
        ) {
            return finish({
                runHealth: "completed",
                productOutcome: "fail",
                failedChecks: [],
                reasonCode: "invalid-result",
            });
        }
        return finish({
            runHealth: "completed",
            productOutcome: failedChecks.length === 0 ? "pass" : "fail",
            failedChecks,
            reasonCode: null,
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
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
