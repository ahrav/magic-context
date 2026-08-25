#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type MutationCase = {
    name: string;
    source: string;
    oldText: string;
    replacement: string;
};

type CommandResult = {
    exit_status: number;
    output: string;
};

const e2eRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(e2eRoot, "../..");
const pluginRoot = resolve(e2eRoot, "../plugin");
const pluginTransform = resolve(
    e2eRoot,
    "../plugin/src/hooks/magic-context/rust-mode-transform.ts",
);
const drillFile = (drill: string) =>
    resolve(e2eRoot, `tests/rust-fm-oc-${drill}.test.ts`);
const commandFor = (drill: string) =>
    `bun run build (packages/plugin) && bun test --timeout 600000 --max-concurrency=1 tests/rust-fm-oc-${drill}.test.ts`;

const mutations: Record<string, MutationCase[]> = {
    "1": [
        {
            name: "FM_OC_1_RUNG_SWAP",
            source: pluginTransform,
            oldText: 'servedFrom = replayed ? "lkg" : "raw";',
            replacement: 'servedFrom = replayed ? "raw" : "lkg";',
        },
        {
            name: "FM_OC_1_RUNG_DELETION",
            source: pluginTransform,
            oldText:
                'sessionLog(sessionId, "rust transform failed; attempting LKG replay:", error);',
            replacement: "",
        },
    ],
    "2": [
        {
            name: "FM_OC_2_RUNG_SWAP",
            source: pluginTransform,
            oldText:
                "if (state.consecutiveFailures < RUST_FAILURE_PARK_THRESHOLD || state.parked) return;",
            replacement:
                "if (state.consecutiveFailures < RUST_FAILURE_PARK_THRESHOLD && state.parked) return;",
        },
        {
            name: "FM_OC_2_RUNG_DELETION",
            source: pluginTransform,
            oldText:
                "sessionLog(\n            sessionId,\n            `mc_rust_park_transition failure_passes=${state.consecutiveFailures} pass_count=${state.passCount} park_count=${state.parkCount}`,\n        );",
            replacement: "",
        },
    ],
    "3": [
        {
            name: "FM_OC_3_RUNG_SWAP",
            source: pluginTransform,
            oldText:
                "passUsageSnapshot.percentage < RUST_PARK_PROBE_PRESSURE_BYPASS_PCT &&\n                state.passCount % RUST_PARK_RETRY_INTERVAL !== 0",
            replacement:
                "passUsageSnapshot.percentage < RUST_PARK_PROBE_PRESSURE_BYPASS_PCT ||\n                state.passCount % RUST_PARK_RETRY_INTERVAL !== 0",
        },
        {
            name: "FM_OC_3_RUNG_DELETION",
            source: pluginTransform,
            oldText:
                "sessionLog(\n            sessionId,\n            `mc_rust_park_transition failure_passes=${state.consecutiveFailures} pass_count=${state.passCount} park_count=${state.parkCount}`,\n        );",
            replacement: "",
        },
    ],
    "4": [
        {
            name: "FM_OC_4_RUNG_SWAP",
            source: pluginTransform,
            oldText: "if (emergencyFailClosed) {",
            replacement: "if (!emergencyFailClosed) {",
        },
        {
            name: "FM_OC_4_RUNG_DELETION",
            source: pluginTransform,
            oldText:
                'sessionLog(sessionId, "mc_rust_emergency_refusal before_lkg");',
            replacement: "",
        },
    ],
    "5": [
        {
            name: "FM_OC_5_RUNG_SWAP",
            source: drillFile("5"),
            oldText: "h.mcHost.pauseHost();\n            await h.sendPrompt",
            replacement:
                "h.mcHost.resumeHost();\n            await h.sendPrompt",
        },
        {
            name: "FM_OC_5_RUNG_DELETION",
            source: drillFile("5"),
            oldText: "assertLoudModuleFailure(h, sessionId);",
            replacement: "",
        },
    ],
    "6": [
        {
            name: "FM_OC_6_RUNG_SWAP",
            source: drillFile("6"),
            oldText: 'expect(after[refusalIndex]).toContain("before_lkg");',
            replacement:
                'expect(after[refusalIndex]).not.toContain("before_lkg");',
        },
        {
            name: "FM_OC_6_RUNG_DELETION",
            source: drillFile("6"),
            oldText:
                'const refusalIndex = after.findIndex((line) =>\n                line.includes("mc_rust_emergency_refusal before_lkg"),\n            );',
            replacement: "const refusalIndex = -1;",
        },
    ],
};

function runBuildAndDrill(drill: string): CommandResult {
    const build = Bun.spawnSync({
        cmd: ["bun", "run", "build"],
        cwd: pluginRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    const decoder = new TextDecoder();
    const buildOutput = `${decoder.decode(build.stdout)}${decoder.decode(build.stderr)}`;
    if (build.exitCode !== 0) {
        return { exit_status: build.exitCode, output: buildOutput };
    }
    const test = Bun.spawnSync({
        cmd: [
            "bun",
            "test",
            "--timeout",
            "600000",
            "--max-concurrency=1",
            `tests/rust-fm-oc-${drill}.test.ts`,
        ],
        cwd: e2eRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
    });
    return {
        exit_status: test.exitCode,
        output: `${buildOutput}${decoder.decode(test.stdout)}${decoder.decode(test.stderr)}`,
    };
}

function applyCase(mutation: MutationCase): { before: string; after: string } {
    const before = readFileSync(mutation.source, "utf8");
    const occurrences = before.split(mutation.oldText).length - 1;
    if (occurrences !== 1) {
        throw new Error(
            `${mutation.name}: expected one mutation target, found ${occurrences}`,
        );
    }
    const after = before.replace(mutation.oldText, mutation.replacement);
    writeFileSync(mutation.source, after);
    return { before, after };
}

const drill = Bun.argv[2];
if (!drill || !mutations[drill]) {
    console.error("usage: bun scripts/run-rust-fm-mutation.ts 1..6");
    process.exit(2);
}

const command = commandFor(drill);
const results: Array<Record<string, unknown>> = [];
for (const mutation of mutations[drill]) {
    const { before, after } = applyCase(mutation);
    let observedFailure: CommandResult;
    try {
        observedFailure = runBuildAndDrill(drill);
    } finally {
        writeFileSync(mutation.source, before);
    }

    const revertedRerun = runBuildAndDrill(drill);
    results.push({
        name: mutation.name,
        applied_diff: {
            path: relative(repoRoot, mutation.source),
            before: mutation.oldText,
            after: mutation.replacement,
            changed: before !== after,
        },
        observed_failure: observedFailure,
        reverted_rerun: {
            ...revertedRerun,
            status: revertedRerun.exit_status === 0 ? "pass" : "fail",
        },
        adequacy_finding:
            observedFailure.exit_status === 0
                ? "mutation did not redden the drill; investigate drill adequacy"
                : null,
    });
    if (revertedRerun.exit_status !== 0) {
        throw new Error(`${mutation.name}: reverted rerun did not pass`);
    }
}

const recordPath = resolve(e2eRoot, `mutations/fm-oc-${drill}.json`);
writeFileSync(
    recordPath,
    `${JSON.stringify({ drill: `FM-OC-${drill}`, command, mutations: results }, null, 2)}\n`,
);
console.log(`wrote ${recordPath}`);
