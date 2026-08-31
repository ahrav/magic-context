#!/usr/bin/env bun

// Seeded-defect audit runner: applies exactly one named unit defect,
// Each mutation's detector must fail.
// After restoration, the clean detector rerun must pass.
// Each invocation runs one unit.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type Detector = {
    cmd: string[];
    cwd: string;
};

type MutationCase = {
    name: string;
    source: string;
    oldText: string;
    replacement: string;
    detector: Detector;
};

type DeferredCase = {
    name: string;
    deferred: string;
};

type UnitCase = MutationCase | DeferredCase;

type CommandResult = {
    exit_status: number;
    output: string;
};

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const pluginRoot = resolve(e2eRoot, "../plugin");

const cargoTest = (args: string[]): Detector => ({
    cmd: ["cargo", "test", ...args],
    cwd: repoRoot,
});

const mutations: Record<string, UnitCase> = {
    u1: {
        name: "SHM_U1_ALLOCATION_SLACK_REACHES_DECODER",
        source: resolve(
            repoRoot,
            "crates/mc-shm-transport/src/backend/iceoryx.rs",
        ),
        oldText:
            "(index == 0).then_some(&self.sample.payload()[PREFIX_BYTES..PREFIX_BYTES + self.body_len])",
        replacement:
            "(index == 0).then_some(&self.sample.payload()[PREFIX_BYTES..])",
        detector: cargoTest([
            "-p",
            "mc-shm-transport",
            "--test",
            "iceoryx",
            "allocation_slack_never_reaches_the_frame_decoder",
        ]),
    },
    u2: {
        name: "SHM_U2_CLEANUP_INSIDE_PREFLIGHT",
        source: resolve(repoRoot, "crates/mc-host/src/shm_provider.rs"),
        oldText: "        PreflightEligibility::Serveable\n    }",
        replacement: [
            "        if let Ok(admission) = self.admission.admit(&self.profile, None) {",
            "            self.recovery",
            "                .report_suspect(self.recovery.admit_candidate(0, admission));",
            "        }",
            "        PreflightEligibility::Serveable",
            "    }",
        ].join("\n"),
        detector: cargoTest([
            "-p",
            "mc-host",
            "--lib",
            "shm_provider::tests::platform_preflight_is_side_effect_free",
        ]),
    },
    u3: {
        name: "SHM_U3_RECOVERY_DEADLINE_RESET_ON_UNAVAILABLE",
        source: resolve(pluginRoot, "src/shared/mc-host-client/client.ts"),
        oldText:
            '                return { kind: selection.reason === "unavailable" ? "retry" : "stop" };',
        replacement: [
            '                if (selection.reason === "unavailable") {',
            "                    (episode as { deadline: Deadline }).deadline =",
            "                        Deadline.start(this.recoveryDeadlineMs, this.clock);",
            '                    return { kind: "retry" };',
            "                }",
            '                return { kind: "stop" };',
        ].join("\n"),
        detector: {
            cmd: [
                "bun",
                "test",
                "src/shared/mc-host-client/shm-recovery.test.ts",
                "-t",
                "original 30s deadline",
            ],
            cwd: pluginRoot,
        },
    },
    u4: {
        name: "SHM_U4_OBSERVATION_TIMING_STARTS_AT_KILL",
        source: resolve(
            repoRoot,
            "crates/mc-host/tests/support/shm_process.rs",
        ),
        oldText:
            '        self.child.kill().expect("SIGKILL role process");\n        KillEvidence {',
        replacement: [
            '        self.child.kill().expect("SIGKILL role process");',
            "        let started_at = Instant::now();",
            "        self.window = Some(ObservationWindow {",
            "            started_at,",
            "            deadline: started_at + OBSERVATION_TIMEOUT,",
            "        });",
            "        KillEvidence {",
        ].join("\n"),
        detector: cargoTest([
            "-p",
            "mc-host",
            "--test",
            "shm_failure_modes",
            "held_zombie_starts_observation_timing_only_after_reap",
        ]),
    },
    u5: {
        name: "SHM_U5_LEAK_ONE_FD_PER_PREPARED_CANDIDATE",
        source: resolve(repoRoot, "crates/mc-host/src/shm_provider.rs"),
        oldText: "        self.preparations.fetch_add(1, Ordering::AcqRel);",
        replacement: [
            "        self.preparations.fetch_add(1, Ordering::AcqRel);",
            '        std::mem::forget(std::fs::File::open("/proc/self/stat"));',
        ].join("\n"),
        detector: cargoTest([
            "-p",
            "mc-host",
            "--test",
            "shm_soak",
            "soak_smoke_conserves_charges_and_stays_inside_the_envelope",
        ]),
    },
    u6: {
        name: "SHM_U6_MACOS_IGNORED_SOAK_INVOCATION_REMOVED",
        deferred:
            "manifest-gated: the failure_hardening manifest is unresolved and " +
            "retains no macOS tuple, so no dedicated macOS ignored-soak " +
            "invocation exists to remove and no workflow-coverage validator " +
            "is implemented yet; freezing a manifest with a retained macOS " +
            "tuple must add both the invocation and the coverage check",
    },
    u7: {
        name: "SHM_U7_RETAINED_TUPLE_OMITTED_FROM_INVENTORY",
        source: resolve(e2eRoot, "scripts/validate-shm-hardening-matrix.ts"),
        oldText: "const categories = new Set(inventory[identity] ?? []);",
        replacement:
            "const categories = new Set(inventory[identity] ?? ADAPTER_CATEGORIES);",
        detector: {
            cmd: [
                "bun",
                "test",
                "scripts/validate-shm-hardening-matrix.test.ts",
            ],
            cwd: e2eRoot,
        },
    },
};

const decoder = new TextDecoder();

function runDetector(detector: Detector): CommandResult {
    const result = Bun.spawnSync({
        cmd: detector.cmd,
        cwd: detector.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    return {
        exit_status: result.exitCode,
        output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
    };
}

const unit = (Bun.argv[2] ?? "").toLowerCase();
const selected = mutations[unit];
if (!selected) {
    console.error("usage: bun scripts/run-mc-shm-hardening-mutation.ts u1..u7");
    process.exit(2);
}

const recordPath = resolve(e2eRoot, `mutations/shm-hardening-${unit}.json`);

if ("deferred" in selected) {
    const record = {
        drill: `SHM-HARDENING-${unit.toUpperCase()}`,
        mutations: [
            {
                name: selected.name,
                status: "deferred",
                reason: selected.deferred,
            },
        ],
    };
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`deferred: ${selected.deferred}`);
    console.log(`wrote ${recordPath}`);
    process.exit(0);
}

const before = readFileSync(selected.source, "utf8");
const occurrences = before.split(selected.oldText).length - 1;
if (occurrences !== 1) {
    throw new Error(
        `${selected.name}: expected one mutation target, found ${occurrences}`,
    );
}
// Restoration must survive termination while the mutation is applied:
// The `finally` block does not run when SIGINT or SIGTERM terminates the process.
// SIGINT or SIGTERM can leave the mutated source in the working copy.
// The SIGINT and SIGTERM handlers restore the original bytes, then terminate.
const restoreSource = (): void => {
    try {
        writeFileSync(selected.source, before);
    } catch {
        // The exit path must not throw so the byte-exact check detects failed restoration.
        // The byte-exact check detects failed restoration on the normal exit path.
    }
};
const onTermination = (signal: NodeJS.Signals): void => {
    restoreSource();
    process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", onTermination);
process.on("SIGTERM", onTermination);
process.on("exit", restoreSource);
writeFileSync(
    selected.source,
    before.replace(selected.oldText, selected.replacement),
);
let observedFailure: CommandResult;
try {
    observedFailure = runDetector(selected.detector);
} finally {
    writeFileSync(selected.source, before);
    process.off("SIGINT", onTermination);
    process.off("SIGTERM", onTermination);
    process.off("exit", restoreSource);
}
if (readFileSync(selected.source, "utf8") !== before) {
    throw new Error(`${selected.name}: byte-exact restoration failed`);
}
const revertedRerun = runDetector(selected.detector);

const record = {
    drill: `SHM-HARDENING-${unit.toUpperCase()}`,
    command: selected.detector.cmd.join(" "),
    mutations: [
        {
            name: selected.name,
            applied_diff: {
                path: relative(repoRoot, selected.source),
                before: selected.oldText,
                after: selected.replacement,
                changed: true,
            },
            observed_failure: observedFailure,
            reverted_rerun: {
                ...revertedRerun,
                status: revertedRerun.exit_status === 0 ? "pass" : "fail",
            },
            adequacy_finding:
                observedFailure.exit_status === 0
                    ? "mutation did not redden the detector; investigate detector adequacy"
                    : null,
        },
    ],
};
writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
console.log(`wrote ${recordPath}`);

if (observedFailure.exit_status === 0) {
    throw new Error(`${selected.name}: mutation did not redden the detector`);
}
if (revertedRerun.exit_status !== 0) {
    throw new Error(`${selected.name}: reverted rerun did not pass`);
}
console.log(`${selected.name}: detector failed mutated and passed restored`);
