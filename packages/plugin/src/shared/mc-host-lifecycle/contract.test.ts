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
            shared_memory: { state: "ready", reason: "healthy" },
            storage: { state: "ready", reason: "healthy" },
            synapse: { state: "ready", reason: "healthy" },
        },
        shared_memory: null,
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

function healthySharedMemory(): Record<string, unknown> {
    const zero = {
        descriptors: 0,
        arena_bytes: 0,
        leases: 0,
        mappings: 0,
        file_descriptors: 0,
        workers: 0,
        client_instances: 0,
        pinned_workers: 0,
    };
    return {
        state: "healthy",
        error_class: null,
        artifact: {
            profile: "mc-host-test-ring-v1",
            wire_version: 2,
            descriptor_schema: 2,
        },
        bounds: { ...zero, arena_bytes: 134_217_728 },
        accounting: { active: zero, quarantined: zero },
        activation: { completed: 1 },
        peer_death: { observed: 0 },
        reclamation: { completed: 0 },
        exhaustion: { observed: 0 },
    };
}

describe("parseDaemonResult", () => {
    test("the accepted ring-diagnostics keys are exactly what the host emits", () => {
        expect(Object.keys(healthySharedMemory()).sort()).toEqual([
            "accounting",
            "activation",
            "artifact",
            "bounds",
            "error_class",
            "exhaustion",
            "peer_death",
            "reclamation",
            "state",
        ]);
        const parsed = parseDaemonResult(
            JSON.stringify(validResult({ shared_memory: healthySharedMemory() })),
        );
        expect(parsed.shared_memory?.state).toBe("healthy");
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        shared_memory: { ...healthySharedMemory(), attachment: { completed: 1 } },
                    }),
                ),
            ),
        ).toThrow(/shared_memory/);
    });

    test("a terminal ring cannot ride alongside a ready component or a pass", () => {
        const terminal = { ...healthySharedMemory(), state: "terminal", error_class: "peer_death" };
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        readiness: { shared_memory: { state: "ready", reason: "healthy" } },
                        shared_memory: terminal,
                    }),
                ),
            ),
        ).toThrow(/terminal shared memory contradicts a ready/);
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        ok: true,
                        readiness: {
                            shared_memory: {
                                state: "unavailable",
                                reason: "native_probe_unavailable",
                            },
                        },
                        shared_memory: terminal,
                    }),
                ),
            ),
        ).toThrow(/terminal shared memory contradicts a successful result/);
    });

    test("unobserved bounds parse as unknown rather than zero", () => {
        // A setup that fails before `host.status` observes neither bounds nor
        // accounting, so unknown is only legal on a terminal record.
        const terminal = {
            ...healthySharedMemory(),
            state: "terminal",
            error_class: "missing_addon",
            bounds: null,
            accounting: null,
        };
        const parsed = parseDaemonResult(
            JSON.stringify(
                validResult({
                    ok: false,
                    reason: "native_probe_unavailable",
                    remediation: "run_daemon_restart",
                    readiness: {
                        shared_memory: {
                            state: "unavailable",
                            reason: "native_probe_unavailable",
                        },
                    },
                    shared_memory: terminal,
                }),
            ),
        );
        expect(parsed.shared_memory?.bounds).toBeNull();
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({ shared_memory: { ...healthySharedMemory(), bounds: null } }),
                ),
            ),
        ).toThrow(/shared_memory/);
    });

    test("accepts a fully populated conforming result", () => {
        const parsed = parseDaemonResult(JSON.stringify(validResult()));
        expect(parsed.command).toBe("status");
        expect(parsed.state).toBe("running");
        expect(parsed.reason).toBe("healthy");
        expect(parsed.checks.length).toBe(2);
        expect(parsed.versions.daemon).toBe("mc-host/0.1.0");
    });

    test("accepts bounded fixed-ring diagnostics", () => {
        const parsed = parseDaemonResult(
            JSON.stringify(validResult({ shared_memory: healthySharedMemory() })),
        );
        expect(parsed.shared_memory?.state).toBe("healthy");
        expect(parsed.shared_memory?.artifact.profile).toBe("mc-host-test-ring-v1");
        expect(parsed.shared_memory?.bounds.arena_bytes).toBe(134_217_728);
    });

    test("accepts exactly five terminal shared-memory classes", () => {
        for (const errorClass of [
            "missing_addon",
            "identity_mismatch",
            "setup_failure",
            "peer_death",
            "resource_exhaustion",
        ] as const) {
            const diagnostics = healthySharedMemory();
            diagnostics.state = "terminal";
            diagnostics.error_class = errorClass;
            diagnostics.accounting = null;
            const parsed = parseDaemonResult(
                JSON.stringify(
                    validResult({
                        ok: false,
                        reason: "native_probe_unavailable",
                        remediation: "run_daemon_restart",
                        readiness: {
                            shared_memory: {
                                state: "unavailable",
                                reason: "native_probe_unavailable",
                            },
                        },
                        shared_memory: diagnostics,
                    }),
                ),
            );
            expect(parsed.shared_memory?.error_class).toBe(errorClass);
        }
    });

    test("rejects unbounded or identifying shared-memory fields", () => {
        const diagnostics = healthySharedMemory();
        diagnostics.socket_path = "/private/service.sock";
        expect(() =>
            parseDaemonResult(JSON.stringify(validResult({ shared_memory: diagnostics }))),
        ).toThrow(ContractViolation);
    });

    test("rejects a probe command in a result and accepts the status it really emits", () => {
        // `probe` is accepted in argv but not in result payloads.
        // Result commands are `start`, `stop`, `restart`, `status`, or `doctor`.
        // `probe` results must use `status`.
        expect(() =>
            parseDaemonResult(
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
            ),
        ).toThrow(/command is outside the closed union/);
        const parsed = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "status",
                    ok: false,
                    state: "stopped",
                    reason: "not_running",
                    remediation: "run_daemon_start",
                    readiness: null,
                    checks: [],
                }),
            ),
        );
        expect(parsed.command).toBe("status");
        expect(parsed.readiness).toBeNull();
    });

    test("readiness may not be ready with a failing reason", () => {
        const withReadiness = (readiness: unknown) =>
            JSON.stringify(
                validResult({
                    command: "start",
                    ok: true,
                    state: "running",
                    reason: "started",
                    remediation: null,
                    readiness,
                    checks: [],
                }),
            );
        expect(() =>
            parseDaemonResult(
                withReadiness({ shared_memory: { state: "ready", reason: "internal_error" } }),
            ),
        ).toThrow(/readiness\.shared_memory is ready with a failing reason/);
        // The converse stays legal, and must: `unsupported` with
        // `synapse_unsupported` is a non-failing pairing for a non-ready state,
        // and every `starting` reason is a failing one.
        const legal = parseDaemonResult(
            withReadiness({
                shared_memory: { state: "ready", reason: "healthy" },
                storage: { state: "starting", reason: "storage_starting" },
                synapse: { state: "unsupported", reason: "synapse_unsupported" },
            }),
        );
        expect(legal.readiness?.shared_memory?.state).toBe("ready");
        expect(legal.readiness?.synapse?.reason).toBe("synapse_unsupported");
    });

    test("an unhealthy ring parses with the reason both emitters produce", () => {
        // `probeManagedReadiness` and `policy.ts` emit `native_probe_unavailable`
        // for an unavailable ring, so rejecting the pair here would make CLI
        // status and doctor output unparseable.
        const parsed = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "status",
                    ok: false,
                    state: "running",
                    reason: "native_probe_unavailable",
                    remediation: "run_daemon_restart",
                    readiness: {
                        shared_memory: {
                            state: "unavailable",
                            reason: "native_probe_unavailable",
                        },
                    },
                    checks: [
                        {
                            id: "readiness.shared_memory",
                            status: "fail",
                            reason: "native_probe_unavailable",
                            remediation: "run_daemon_restart",
                        },
                    ],
                }),
            ),
        );
        expect(parsed.readiness?.shared_memory?.state).toBe("unavailable");
        expect(parsed.readiness?.shared_memory?.reason).toBe("native_probe_unavailable");
    });

    test("binds pass and fail checks to their reason classes, leaving warn and skip free", () => {
        const withCheck = (status: string, reason: string, remediation: string | null) =>
            JSON.stringify(
                validResult({
                    command: "doctor",
                    ok: false,
                    state: "wedged",
                    reason: "wedged",
                    remediation: "inspect_daemon_process",
                    readiness: null,
                    checks: [{ id: "platform.support", status, reason, remediation }],
                }),
            );
        expect(() => parseDaemonResult(withCheck("pass", "internal_error", "report_bug"))).toThrow(
            /passing check carries a failing reason/,
        );
        expect(() => parseDaemonResult(withCheck("fail", "healthy", null))).toThrow(
            /failing check carries a non-failing reason/,
        );
        // `warn` means degraded but usable, and `skip` means absent evidence, so neither status constrains the reason class.
        for (const status of ["warn", "skip"]) {
            const parsed = parseDaemonResult(withCheck(status, "internal_error", "report_bug"));
            expect(parsed.checks[0]?.status).toBe(status);
            const nonFailing = parseDaemonResult(withCheck(status, "healthy", null));
            expect(nonFailing.checks[0]?.reason).toBe("healthy");
        }
        expect(parseDaemonResult(withCheck("pass", "healthy", null)).checks[0]?.status).toBe(
            "pass",
        );
        expect(
            parseDaemonResult(withCheck("fail", "internal_error", "report_bug")).checks[0]?.status,
        ).toBe("fail");
    });

    test("rejects a successful restart carrying no effects at all", () => {
        // A successful restart requires `effects.start_committed: true`.
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        command: "restart",
                        ok: true,
                        state: "running",
                        reason: "started",
                        remediation: null,
                        readiness: null,
                        checks: [],
                        effects: null,
                    }),
                ),
            ),
        ).toThrow(/successful restart must carry its effects/);
        // A failed restart may omit `effects` because a killed transaction's outcome is unknown.
        // The policy reports `effects: null` rather than claiming that either operation committed.
        // nothing committed.
        const killed = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "restart",
                    ok: false,
                    state: "wedged",
                    reason: "internal_error",
                    remediation: "report_bug",
                    readiness: null,
                    checks: [],
                    effects: null,
                }),
            ),
        );
        expect(killed.effects).toBeNull();
    });

    test("rejects a successful restart that committed no start", () => {
        // `ok: true` requires `effects.start_committed: true` because restart success is the successor start's outcome.
        // `ok: true` produces exit code 0.
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        command: "restart",
                        ok: true,
                        state: "running",
                        reason: "started",
                        remediation: null,
                        readiness: null,
                        checks: [],
                        effects: { stop_committed: true, start_committed: false },
                    }),
                ),
            ),
        ).toThrow(/successful restart must report a committed start/);
        // `ok: false` may coexist with `effects.start_committed: true`.
        // `effects.start_committed: true` records a committed effect, not a contradiction.
        const partial = parseDaemonResult(
            JSON.stringify(
                validResult({
                    command: "restart",
                    ok: false,
                    state: "wedged",
                    reason: "wedged",
                    remediation: "inspect_daemon_process",
                    readiness: null,
                    checks: [],
                    effects: { stop_committed: true, start_committed: true },
                }),
            ),
        );
        expect(partial.effects).toEqual({ stop_committed: true, start_committed: true });
    });

    test("rejects a remediation borrowed from another reason", () => {
        // State the exact invalid `state` and `reason` values.
        // Accepting the invalid pair would instruct an operator to free storage when the native payload is absent.
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        command: "start",
                        ok: false,
                        state: "stopped",
                        reason: "native_payload_missing",
                        remediation: "free_storage",
                        readiness: null,
                        checks: [],
                    }),
                ),
            ),
        ).toThrow(/remediation does not match its reason/);
        // A success carries no remediation at all.
        expect(() =>
            parseDaemonResult(
                JSON.stringify(
                    validResult({
                        command: "start",
                        ok: true,
                        state: "running",
                        reason: "started",
                        remediation: "wait_and_retry",
                        readiness: null,
                        checks: [],
                    }),
                ),
            ),
        ).toThrow(/remediation does not match its reason/);
    });

    test("rejects every malformed shape fail-closed", () => {
        const cases: Record<string, Record<string, unknown>> = {
            wrong_schema: validResult({ schema: "magic-context.daemon/v2" }),
            unknown_command: validResult({ command: "reload" }),
            unknown_state: validResult({ state: "paused" }),
            unknown_reason: validResult({ reason: "mystery" }),
            unknown_remediation: validResult({ remediation: "reboot" }),
            unavailable_without_no_data_dir: validResult({ state: "unavailable" }),
            ok_reason_mismatch: validResult({
                ok: false,
                reason: "healthy",
            }),
            state_reason_mismatch: validResult({
                state: "wedged",
            }),
            wrong_remediation_for_reason: validResult({
                ok: false,
                state: "stopped",
                reason: "not_running",
                remediation: "free_storage",
                readiness: null,
                checks: [],
            }),
            restart_without_effects: validResult({
                command: "restart",
                reason: "started",
            }),
            readiness_reason_mismatch: validResult({
                readiness: {
                    shared_memory: { state: "ready", reason: "not_running" },
                },
            }),
            successful_result_with_failed_check: validResult({
                checks: [
                    {
                        id: "lifecycle.fences",
                        status: "fail",
                        reason: "wedged",
                        remediation: "inspect_daemon_process",
                    },
                ],
            }),
            effects_on_non_restart: validResult({
                effects: { stop_committed: true, start_committed: true },
            }),
            extra_top_level_field: validResult({ extra: 1 }),
            unknown_readiness_component: validResult({
                readiness: {
                    shared_memory: { state: "ready", reason: "healthy" },
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
            ok_true_with_failing_reason: validResult({ reason: "internal_error" }),
            ok_false_with_non_failing_reason: validResult({
                ok: false,
                state: "stopped",
                readiness: null,
                checks: [],
            }),
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

        for (const outcome of [
            {
                state: "stopped",
                reason: "internal_error",
                remediation: "report_bug",
            },
            {
                state: "stopping",
                reason: "shutdown_timeout",
                remediation: "inspect_daemon_process",
            },
        ] as const) {
            const committedFailure = parseDaemonResult(
                JSON.stringify(
                    validResult({
                        command: "restart",
                        ok: false,
                        ...outcome,
                        readiness: null,
                        checks: [],
                        effects: { stop_committed: true, start_committed: true },
                    }),
                ),
            );
            expect(committedFailure.effects).toEqual({
                stop_committed: true,
                start_committed: true,
            });
        }
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

    test("agreement cannot be reached by a failing reason wearing ok:true", () => {
        // Exit-status validation uses `ok` alone.
        // An `ok: true` result with a failing reason would produce exit code 0 and let callers proceed after a failure.
        expect(() =>
            parseDaemonResult(JSON.stringify(validResult({ reason: "internal_error" }))),
        ).toThrow(ContractViolation);
        const paired = parseDaemonResult(
            JSON.stringify(
                validResult({
                    ok: false,
                    state: "wedged",
                    reason: "internal_error",
                    remediation: "report_bug",
                    readiness: null,
                    checks: [],
                }),
            ),
        );
        expect(exitAgreesWithResult(0, paired)).toBe(false);
        expect(exitAgreesWithResult(1, paired)).toBe(true);
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
            // `data-path.ts` creates the application SQLite store on every installation, so the store's presence does not imply that a daemon ran.
            // The application SQLite store's presence does not imply that a daemon ran.
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
