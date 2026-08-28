import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ContractViolation,
    classifyPreNativeRoots,
    exitAgreesWithResult,
    harnessRemediationFor,
    parseDaemonResult,
    preNativeState,
    probeFallbackVerdict,
    reasonPrecedence,
    remediationForReason,
} from "./contract";
import { releaseContract } from "./generated-contract";

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema: "magic-context.daemon/v1",
        command: "status",
        ok: true,
        state: "running",
        reason: "healthy",
        remediation: null,
        effects: null,
        readiness: {
            transport: { state: "ready", reason: "healthy" },
            storage: { state: "ready", reason: "healthy" },
            synapse: { state: "ready", reason: "healthy" },
        },
        checks: [
            { id: "compatibility.daemon", status: "pass", reason: "healthy", remediation: null },
            { id: "lifecycle.publication", status: "pass", reason: "healthy", remediation: null },
        ],
        versions: {
            release: "0.38.0",
            proof: "current",
            daemon: "mc-host/0.1.0",
            magic_context: "0.1.0",
            synapse: "0.1.0",
            broca: "0.1.0",
        },
        ...overrides,
    };
}

describe("parseDaemonResult", () => {
    test("accepts a fully populated conforming result", () => {
        const parsed = parseDaemonResult(JSON.stringify(validResult()));
        expect(parsed.command).toBe("status");
        expect(parsed.state).toBe("running");
        expect(parsed.reason).toBe("healthy");
        expect(parsed.checks.length).toBe(2);
        expect(parsed.versions.daemon).toBe("mc-host/0.1.0");
    });

    test("accepts the native binary's probe command and null readiness", () => {
        const parsed = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "probe",
                    ok: false,
                    state: "stopped",
                    reason: "not_running",
                    remediation: "run_daemon_start",
                    readiness: null,
                    checks: [],
                }),
            ),
        );
        expect(parsed.command).toBe("probe");
        expect(parsed.readiness).toBeNull();
    });

    test("rejects every malformed shape fail-closed", () => {
        const cases: Record<string, Record<string, unknown>> = {
            wrong_schema: validResult({ schema: "magic-context.daemon/v2" }),
            unknown_command: validResult({ command: "reload" }),
            unknown_state: validResult({ state: "paused" }),
            unknown_reason: validResult({ reason: "mystery" }),
            unknown_remediation: validResult({ remediation: "reboot" }),
            unavailable_without_no_data_dir: validResult({ state: "unavailable" }),
            effects_on_non_restart: validResult({
                effects: { stop_committed: true, start_committed: true },
            }),
            extra_top_level_field: validResult({ extra: 1 }),
            unknown_readiness_component: validResult({
                readiness: {
                    transport: { state: "ready", reason: "healthy" },
                    gpu: { state: "ready", reason: "healthy" },
                },
            }),
            readiness_state_outside_component_set: validResult({
                readiness: { storage: { state: "degraded", reason: "healthy" } },
            }),
            unknown_check_id: validResult({
                checks: [
                    { id: "custom.check", status: "pass", reason: "healthy", remediation: null },
                ],
            }),
            unsorted_checks: validResult({
                checks: [
                    {
                        id: "lifecycle.publication",
                        status: "pass",
                        reason: "healthy",
                        remediation: null,
                    },
                    {
                        id: "compatibility.daemon",
                        status: "pass",
                        reason: "healthy",
                        remediation: null,
                    },
                ],
            }),
            duplicate_checks: validResult({
                checks: [
                    {
                        id: "compatibility.daemon",
                        status: "pass",
                        reason: "healthy",
                        remediation: null,
                    },
                    {
                        id: "compatibility.daemon",
                        status: "pass",
                        reason: "healthy",
                        remediation: null,
                    },
                ],
            }),
            missing_versions_key: validResult({
                versions: {
                    release: "0.38.0",
                    proof: null,
                    daemon: null,
                    magic_context: null,
                    synapse: null,
                },
            }),
            non_boolean_ok: validResult({ ok: "yes" }),
        };
        for (const [name, body] of Object.entries(cases)) {
            let rejected = false;
            try {
                parseDaemonResult(JSON.stringify(body));
            } catch (error) {
                rejected = error instanceof ContractViolation;
            }
            expect({ name, rejected }).toEqual({ name, rejected: true });
        }
    });

    test("rejects non-single-object output: empty, trailing bytes, arrays", () => {
        expect(() => parseDaemonResult("")).toThrow(ContractViolation);
        expect(() => parseDaemonResult("[]")).toThrow(ContractViolation);
        expect(() => parseDaemonResult(`${JSON.stringify(validResult())}{"second":1}`)).toThrow(
            ContractViolation,
        );
    });

    test("valid restart effects parse; unavailable requires no_data_dir", () => {
        const restart = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "restart",
                    ok: false,
                    state: "unavailable",
                    reason: "no_data_dir",
                    remediation: "set_data_directory",
                    readiness: null,
                    checks: [],
                    effects: { stop_committed: false, start_committed: false },
                }),
            ),
        );
        expect(restart.effects).toEqual({ stop_committed: false, start_committed: false });
    });

    test("schema violations never echo oversized native text", () => {
        const long = validResult({ reason: "x".repeat(10_000) });
        try {
            parseDaemonResult(JSON.stringify(long));
            throw new Error("expected rejection");
        } catch (error) {
            expect(error).toBeInstanceOf(ContractViolation);
            expect((error as Error).message.length).toBeLessThan(300);
        }
    });
});

describe("exit/result agreement", () => {
    test("exit 0 requires ok:true, exit 1 requires ok:false, others disagree", () => {
        const okResult = parseDaemonResult(JSON.stringify(validResult()));
        const failResult = parseDaemonResult(
            JSON.stringify(
                validResult({
                    ok: false,
                    state: "stopped",
                    reason: "not_running",
                    remediation: "run_daemon_start",
                    readiness: null,
                    checks: [],
                }),
            ),
        );
        expect(exitAgreesWithResult(0, okResult)).toBe(true);
        expect(exitAgreesWithResult(1, okResult)).toBe(false);
        expect(exitAgreesWithResult(0, failResult)).toBe(false);
        expect(exitAgreesWithResult(1, failResult)).toBe(true);
        expect(exitAgreesWithResult(2, okResult)).toBe(false);
    });
});

describe("reason vocabulary pins", () => {
    test("remediation and precedence mirror the generated contract exactly", () => {
        releaseContract.cli.reasons.failing_by_precedence.forEach((entry, index) => {
            expect(reasonPrecedence(entry.id)).toBe(index + 1);
            expect(remediationForReason(entry.id)).toBe(entry.remediation ?? null);
        });
        for (const reason of releaseContract.cli.reasons.non_failing) {
            expect(reasonPrecedence(reason)).toBeNull();
            expect(remediationForReason(reason)).toBeNull();
        }
    });

    test("harness subreason remediation is closed and unknown values fail", () => {
        expect(harnessRemediationFor("provider_unsupported")).toBeNull();
        expect(harnessRemediationFor("auth_mechanism_unsupported")).toBeNull();
        expect(harnessRemediationFor("descriptor_absent")).toBe("restart_with_supported_harness");
        expect(harnessRemediationFor("credential_snapshot_mismatch")).toBe(
            "restart_with_supported_harness",
        );
        expect(() => harnessRemediationFor("novel_reason")).toThrow(ContractViolation);
    });
});

describe("pre-native root classifier", () => {
    function tempRoot(): string {
        return mkdtempSync(path.join(os.tmpdir(), "mc-lifecycle-classifier-"));
    }

    test("definitely absent coordination and managed roots classify stopped", () => {
        const root = tempRoot();
        try {
            const classification = classifyPreNativeRoots(root);
            expect(classification).toEqual({ kind: "absent" });
            expect(preNativeState(classification)).toBe("stopped");
            expect(probeFallbackVerdict(classification)).toEqual({
                state: "stopped",
                reason: "not_running",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("residual coordination evidence is wedged / native_probe_unavailable", () => {
        const root = tempRoot();
        try {
            mkdirSync(path.join(root, ".mc-host-coordination"));
            const classification = classifyPreNativeRoots(root);
            expect(classification).toEqual({ kind: "residual" });
            expect(preNativeState(classification)).toBe("wedged");
            expect(probeFallbackVerdict(classification)).toEqual({
                state: "wedged",
                reason: "native_probe_unavailable",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a residual daemon runtime directory alone is also wedged", () => {
        const root = tempRoot();
        try {
            mkdirSync(path.join(root, "cortexkit", "run"), { recursive: true });
            expect(classifyPreNativeRoots(root).kind).toBe("residual");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("the shared cortexkit subtree alone is not daemon residue", () => {
        const root = tempRoot();
        try {
            // `data-path.ts` puts the application SQLite store here on every
            // install, so its presence must not imply a daemon ever ran.
            mkdirSync(path.join(root, "cortexkit", "magic-context"), { recursive: true });
            const classification = classifyPreNativeRoots(root);
            expect(classification).toEqual({ kind: "absent" });
            expect(preNativeState(classification)).toBe("stopped");
            expect(probeFallbackVerdict(classification)).toEqual({
                state: "stopped",
                reason: "not_running",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a symlinked root is a hazard, never stopped", () => {
        const root = tempRoot();
        try {
            const target = path.join(root, "elsewhere");
            mkdirSync(target);
            mkdirSync(path.join(root, "cortexkit"));
            symlinkSync(target, path.join(root, "cortexkit", "run"));
            const classification = classifyPreNativeRoots(root);
            expect(classification).toEqual({ kind: "hazard", hazard: "symlink" });
            expect(probeFallbackVerdict(classification)).toEqual({
                state: "wedged",
                reason: "native_probe_unavailable",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("a special-file root is a hazard", () => {
        const root = tempRoot();
        try {
            writeFileSync(path.join(root, ".mc-host-coordination"), "not a directory");
            expect(classifyPreNativeRoots(root)).toEqual({ kind: "hazard", hazard: "special" });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("an access error is a hazard and never authorizes mutation", () => {
        if (process.getuid?.() === 0) return;
        const root = tempRoot();
        const guarded = path.join(root, "guarded");
        mkdirSync(guarded);
        mkdirSync(path.join(guarded, ".mc-host-coordination"));
        chmodSync(guarded, 0o000);
        try {
            expect(classifyPreNativeRoots(guarded)).toEqual({
                kind: "hazard",
                hazard: "access_error",
            });
        } finally {
            chmodSync(guarded, 0o700);
            rmSync(root, { recursive: true, force: true });
        }
    });
});
